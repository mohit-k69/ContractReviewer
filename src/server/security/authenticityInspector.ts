import { AuthenticityInspectionResult } from './types';
import { findPdfDangers } from './activeContentInspector';

// Common executable extensions used in disguised double extensions
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'vbs', 'ps1', 'js', 'jse', 'wsf', 'wsh',
  'msi', 'com', 'scr', 'hta', 'cpl', 'jar', 'pif', 'reg', 'dll', 'so',
]);

export function inspectFileAuthenticity(
  buffer: Buffer,
  filename: string,
  declaredMimeType: string
): AuthenticityInspectionResult {
  const details: string[] = [];
  let detectedFormat: 'pdf' | 'docx' | 'txt' | 'unknown' = 'unknown';
  let mimeMatch = false;
  let doubleExtensionDetected = false;
  let passwordProtected = false;
  let corrupted = false;

  // 1. Check for double extensions
  const nameParts = filename.toLowerCase().split('.').filter(Boolean);
  if (nameParts.length > 2) {
    for (let i = 1; i < nameParts.length; i++) {
      if (DANGEROUS_EXTENSIONS.has(nameParts[i])) {
        doubleExtensionDetected = true;
        details.push(`Suspicious secondary/trailing extension detected: .${nameParts[i]}`);
      }
    }
  }

  // 2. Identify file signature (Magic Numbers)
  if (buffer.length < 4) {
    corrupted = true;
    details.push('File is too small to contain a valid file header.');
    return {
      passed: false,
      detectedFormat: 'unknown',
      mimeMatch: false,
      doubleExtensionDetected,
      passwordProtected: false,
      corrupted: true,
      details,
    };
  }

  const magic4 = buffer.subarray(0, 4);

  // Check PDF signature: %PDF- (0x25, 0x50, 0x44, 0x46)
  // Some valid PDFs have comments or byte order marks in the first 1024 bytes
  const headerSlice = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  const pdfIndex = headerSlice.indexOf('%PDF-');
  const isPdfMagic = pdfIndex >= 0 && pdfIndex < 1024;

  // Check ZIP signature for DOCX: PK\x03\x04 (0x50, 0x4B, 0x03, 0x04)
  const isZipMagic =
    magic4[0] === 0x50 &&
    magic4[1] === 0x4b &&
    magic4[2] === 0x03 &&
    magic4[3] === 0x04;

  // Executable binaries disguised as documents (signatures: Windows PE "MZ", ELF, Java class / Mach-O fat, Mach-O)
  const hex4 = magic4.toString('hex');
  const isWindowsExecutable = magic4[0] === 0x4d && magic4[1] === 0x5a; // MZ
  const isElfExecutable = hex4 === '7f454c46'; // \x7fELF
  const isOtherExecutable = ['cafebabe', 'cafebabf', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'bebafeca', 'bfbafeca'].includes(hex4);

  if (isWindowsExecutable || isElfExecutable || isOtherExecutable) {
    details.push('Executable binary magic signature detected in document header.');
    return {
      passed: false,
      detectedFormat: 'unknown',
      mimeMatch: false,
      doubleExtensionDetected,
      passwordProtected: false,
      corrupted: false,
      details,
    };
  }

  const lowerName = filename.toLowerCase();

  if (isPdfMagic) {
    detectedFormat = 'pdf';
    mimeMatch =
      declaredMimeType.includes('pdf') ||
      declaredMimeType === 'application/octet-stream';
    if (!lowerName.endsWith('.pdf')) {
      details.push('File format mismatch: file contains PDF signature but lacks .pdf extension.');
    }

    // Check for password protection / encryption in PDF
    // Look for /Encrypt dictionary
    const pdfContentSample = buffer.toString('latin1');
    if (findPdfDangers(pdfContentSample).encrypted) {
      passwordProtected = true;
      details.push('PDF document is encrypted or password-protected and cannot be securely inspected.');
    }
  } else if (isZipMagic) {
    detectedFormat = 'docx';
    mimeMatch =
      declaredMimeType.includes('officedocument') ||
      declaredMimeType.includes('zip') ||
      declaredMimeType === 'application/octet-stream';
    if (!lowerName.endsWith('.docx')) {
      details.push('File format mismatch: file is a ZIP container but lacks .docx extension.');
    }

    // Quick check if it contains encrypted package or standard word components
    const zipString = buffer.subarray(0, Math.min(buffer.length, 16384)).toString('latin1');
    if (zipString.includes('EncryptedPackage') || zipString.includes('EncryptionInfo')) {
      passwordProtected = true;
      details.push('DOCX document is password-protected/encrypted and cannot be inspected.');
    }
  } else {
    // Check if it's valid TXT (UTF-8 or ASCII without null bytes or binary controls)
    if (lowerName.endsWith('.txt')) {
      // Inspect for null bytes or excessive non-printable control characters
      let hasNullByte = false;
      let nonPrintableCount = 0;
      const sampleLimit = Math.min(buffer.length, 8192);

      for (let i = 0; i < sampleLimit; i++) {
        const byte = buffer[i];
        if (byte === 0x00) {
          hasNullByte = true;
          break;
        }
        // Allow newline (0x0A), carriage return (0x0D), tab (0x09)
        if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
          nonPrintableCount++;
        }
      }

      if (hasNullByte || nonPrintableCount > 10) {
        corrupted = true;
        detectedFormat = 'unknown';
        details.push('Text document contains illegal null bytes or binary control characters.');
      } else {
        detectedFormat = 'txt';
        mimeMatch =
          declaredMimeType.includes('text') ||
          declaredMimeType === 'application/octet-stream';
      }
    } else {
      detectedFormat = 'unknown';
      details.push(`Unsupported or unrecognized document format for file: ${filename}`);
    }
  }

  const passed =
    !doubleExtensionDetected &&
    !passwordProtected &&
    !corrupted &&
    detectedFormat !== 'unknown' &&
    details.length === 0;

  return {
    passed,
    detectedFormat,
    mimeMatch,
    doubleExtensionDetected,
    passwordProtected,
    corrupted,
    details,
  };
}
