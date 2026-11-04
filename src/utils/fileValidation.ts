export const MAX_FILE_SIZE_MB = 20;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt'];

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return '';
  return filename.slice(dotIndex).toLowerCase();
}

export function validateContractFile(file: {
  name: string;
  size: number;
  type?: string;
}): FileValidationResult {
  const extension = getFileExtension(file.name);

  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return {
      valid: false,
      error: `Unsupported file type (${extension || 'unknown'}). Please upload a PDF, DOCX, or TXT file.`,
    };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File is too large (${formatFileSize(file.size)}). Maximum allowed size is ${MAX_FILE_SIZE_MB} MB.`,
    };
  }

  if (file.size === 0) {
    return {
      valid: false,
      error: 'The selected file is empty.',
    };
  }

  return { valid: true };
}
