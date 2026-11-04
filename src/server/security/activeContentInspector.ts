import AdmZip from 'adm-zip';
import { ActiveContentInspectionResult } from './types';

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

    // PDF active content inspection
    if (content.includes('/JavaScript') || content.includes('/JS')) {
      hasJavaScript = true;
      details.push('Active content detected: PDF contains embedded JavaScript (/JavaScript or /JS).');
    }

    if (content.includes('/Launch')) {
      hasLaunchActions = true;
      details.push('Malicious action detected: PDF contains /Launch action designed to execute external commands.');
    }

    if (content.includes('/OpenAction') || content.includes('/AA')) {
      hasAutomaticActions = true;
      details.push('Suspicious automated action detected: PDF contains /OpenAction or /AA (Additional Actions).');
    }

    if (content.includes('/EmbeddedFiles') || content.includes('/EmbeddedFile')) {
      hasEmbeddedFiles = true;
      details.push('Suspicious attachment detected: PDF contains /EmbeddedFiles payload.');
    }
  } else if (format === 'docx') {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();

      for (const entry of entries) {
        const name = entry.entryName.toLowerCase();

        // 1. Check for macros
        if (
          name.includes('vbaproject.bin') ||
          name.includes('vbadat.xml') ||
          name.endsWith('.bin') && name.includes('vba')
        ) {
          hasMacros = true;
          details.push(`Active content detected: DOCX contains macro component (${entry.entryName}).`);
        }

        // 2. Check for embedded OLE objects
        if (
          name.includes('oleobject') ||
          name.startsWith('word/embeddings/')
        ) {
          hasOleObjects = true;
          details.push(`Active content detected: DOCX contains embedded OLE object or binary payload (${entry.entryName}).`);
        }

        // 3. Check relationships for suspicious external targets
        if (name.endsWith('.rels')) {
          const relContent = entry.getData().toString('utf8');
          // Check for external targets attempting to execute scripts, file protocols, or ms-msdt exploits (Follina)
          const lowerRel = relContent.toLowerCase();
          if (
            lowerRel.includes('targetmode="external"') &&
            (lowerRel.includes('ms-msdt:') ||
             lowerRel.includes('file:///') ||
             lowerRel.includes('.vbs') ||
             lowerRel.includes('.exe') ||
             lowerRel.includes('.ps1') ||
             lowerRel.includes('.bat'))
          ) {
            hasSuspiciousExternalRelationships = true;
            details.push(`Suspicious external relationship exploit found in ${entry.entryName}.`);
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
