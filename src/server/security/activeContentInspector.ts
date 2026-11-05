import AdmZip from 'adm-zip';
import { ActiveContentInspectionResult } from './types';

/** A PDF name ends at whitespace or a delimiter. */
const NAME_END = '(?![^\\s()<>\\[\\]{}/%])';
/** What follows a dictionary key: a dictionary, string, array, name or an indirect reference ("7 0 R"). */
const VALUE_START = '\\s*(?:<<|\\(|<|\\[|\\d+\\s+\\d+\\s+R|/[A-Za-z])';

/**
 * True if `content` contains the PDF name object `/<name>` as a whole token. In PDF syntax a name ends at
 * whitespace or a delimiter, so `/AA` matches `/AA <<` but NOT the font name `/AAAAAA+TimesNewRomanPS-BoldMT`,
 * and `/JS` does not match `/JSON`. Plain substring matching mistakes ordinary text and font names for actions.
 */
export function hasPdfName(content: string, name: string): boolean {
  return new RegExp(`/${name}${NAME_END}`).test(content);
}

/**
 * True if `/<name>` is used as a dictionary KEY, i.e. it is followed by a value. Prose such as "Marketing/Launch Plan"
 * or "see /JS in the schedule" has the same characters but is not a dictionary entry.
 */
export function hasPdfKey(content: string, name: string): boolean {
  return new RegExp(`/${name}${NAME_END}${VALUE_START}`).test(content);
}

const pdfActionIs = (content: string, action: string): boolean => new RegExp(`/S\\s*/${action}${NAME_END}`).test(content);

/** Genuinely dangerous PDF components, recognised from PDF dictionary syntax rather than from arbitrary text. */
export function findPdfDangers(content: string): { javascript: boolean; launch: boolean; embeddedFiles: boolean; encrypted: boolean; autoTrigger: boolean } {
  return {
    javascript: pdfActionIs(content, 'JavaScript') || hasPdfKey(content, 'JS') || hasPdfKey(content, 'JavaScript'),
    launch: pdfActionIs(content, 'Launch') || new RegExp(`/Launch${NAME_END}\\s*(?:<<|\\(|<)`).test(content),
    embeddedFiles: new RegExp(`/Type\\s*/EmbeddedFile${NAME_END}`).test(content) || hasPdfKey(content, 'EmbeddedFiles') || new RegExp(`/EF${NAME_END}\\s*<<`).test(content),
    encrypted: new RegExp(`/Encrypt${NAME_END}\\s*(?:<<|\\d+\\s+\\d+\\s+R)`).test(content),
    autoTrigger: hasPdfKey(content, 'OpenAction') || hasPdfKey(content, 'AA'),
  };
}

// Executable / script components that have no business inside a contract
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'hta', 'scr', 'msi', 'jar', 'sh', 'cpl', 'pif',
]);
// OOXML packages embedded as data (for example a chart's workbook) are not executable components
const BENIGN_EMBEDDINGS = new Set(['xlsx', 'docx', 'pptx']);
// Schemes that make an external relationship an exploit (Follina and friends) rather than an ordinary link
const DANGEROUS_SCHEMES = new Set(['ms-msdt:', 'search-ms:', 'file:', 'javascript:', 'vbscript:', 'ms-officecmd:']);

const extensionOf = (name: string): string => {
  const base = name.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** True if the bytes start with a Windows (MZ) or Linux (ELF) executable signature. */
const looksExecutable = (data: Buffer): boolean =>
  (data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a) ||
  (data.length >= 4 && data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46);

export function inspectActiveContent(
  buffer: Buffer,
  format: 'pdf' | 'docx' | 'txt' | 'unknown'
): ActiveContentInspectionResult {
  const details: string[] = [];
  let hasJavaScript = false;
  let hasAutomaticActions = false;
  let hasLaunchActions = false;
  let hasEmbeddedFiles = false;
  let hasMacros = false;
  let hasOleObjects = false;
  let hasSuspiciousExternalRelationships = false;
  let hasInvalidEncoding = false;

  if (format === 'pdf') {
    const content = buffer.toString('latin1');

    const danger = findPdfDangers(content);

    if (danger.javascript) {
      hasJavaScript = true;
      details.push('Active content detected: PDF contains embedded JavaScript (a /JavaScript action or /JS entry).');
    }

    if (danger.launch) {
      hasLaunchActions = true;
      details.push('Malicious action detected: PDF contains a /Launch action designed to run an external program.');
    }

    // /OpenAction and /AA (additional actions) only say WHEN an action runs; many ordinary PDFs use /OpenAction
    // to jump to the first page. They matter only when the action they trigger is dangerous.
    if (danger.autoTrigger && (hasJavaScript || hasLaunchActions)) {
      hasAutomaticActions = true;
      details.push('Dangerous action runs automatically: /OpenAction or /AA triggers JavaScript or a launch action.');
    }

    if (danger.embeddedFiles) {
      hasEmbeddedFiles = true;
      details.push('Suspicious attachment detected: PDF contains embedded file attachments.');
    }
  } else if (format === 'docx') {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const name = entry.entryName.replace(/\\/g, '/').toLowerCase();
        const base = name.split('/').pop() ?? '';
        const ext = extensionOf(name);

        // 1. Macros (a macro-enabled package, even if it is called .docx)
        if (base === 'vbaproject.bin' || base === 'vbadata.xml' || base === 'vbaprojectsignature.bin') {
          hasMacros = true;
          details.push(`Active content detected: DOCX contains macro component (${entry.entryName}).`);
        }
        if (name === '[content_types].xml' && entry.getData().toString('utf8').toLowerCase().includes('macroenabled')) {
          hasMacros = true;
          details.push('Active content detected: DOCX is a macro-enabled document.');
        }

        // 2. ActiveX controls and embedded OLE objects / binary payloads
        if (name.startsWith('word/activex/') || /(^|\/)oleobject\d*\.bin$/.test(name) || (name.startsWith('word/embeddings/') && !BENIGN_EMBEDDINGS.has(ext))) {
          hasOleObjects = true;
          details.push(`Active content detected: DOCX contains an ActiveX control, embedded OLE object or binary payload (${entry.entryName}).`);
        }

        // 3. Executable or script components anywhere in the package, by extension or by file signature
        if (EXECUTABLE_EXTENSIONS.has(ext) || ((ext === 'bin' || ext === 'dat' || ext === '') && looksExecutable(entry.getData().subarray(0, 4)))) {
          hasEmbeddedFiles = true;
          details.push(`Executable component detected inside DOCX package (${entry.entryName}).`);
        }

        // 4. External relationships: judge each relationship's own Target, not the whole file
        if (name.endsWith('.rels')) {
          const rels = entry.getData().toString('utf8');
          for (const tag of rels.match(/<Relationship\b[^>]*>/gi) ?? []) {
            if (!/TargetMode\s*=\s*["']External["']/i.test(tag)) continue;
            const target = /Target\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
            const type = /Type\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
            const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(target)?.[1].toLowerCase() ?? '';
            const isHyperlink = /\/hyperlink$/i.test(type);
            const path = target.replace(/[?#].*$/, '');
            const dangerous =
              DANGEROUS_SCHEMES.has(scheme) ||
              // an ordinary hyperlink is just a link; anything else that loads an executable/script is not
              (!isHyperlink && EXECUTABLE_EXTENSIONS.has(extensionOf(path.toLowerCase())));
            if (dangerous) {
              hasSuspiciousExternalRelationships = true;
              details.push(`Dangerous external relationship found in ${entry.entryName}.`);
            }
          }
        }
      }
    } catch {
      // Structure failure handled in structureInspector
    }
  } else if (format === 'txt') {
    // Validate text encoding
    try {
      const str = buffer.toString('utf8');
      // If converting to utf-8 and back changes length drastically or contains null bytes
      if (str.includes('\0')) {
        hasInvalidEncoding = true;
        details.push('Suspicious text content: contains embedded null bytes or binary characters.');
      }
    } catch {
      hasInvalidEncoding = true;
      details.push('Text file has invalid character encoding.');
    }
  }

  const passed =
    !hasJavaScript &&
    !hasAutomaticActions &&
    !hasLaunchActions &&
    !hasEmbeddedFiles &&
    !hasMacros &&
    !hasOleObjects &&
    !hasSuspiciousExternalRelationships &&
    !hasInvalidEncoding;

  return {
    passed,
    hasJavaScript,
    hasAutomaticActions,
    hasLaunchActions,
    hasEmbeddedFiles,
    hasMacros,
    hasOleObjects,
    hasSuspiciousExternalRelationships,
    hasInvalidEncoding,
    details: details.length ? details : ['No active scripts, macros, launch actions or suspicious embedded content detected.'],
  };
}
