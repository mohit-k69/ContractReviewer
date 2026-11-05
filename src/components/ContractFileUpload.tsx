import React, { useRef, useState, useEffect } from 'react';
import { UploadCloud, FileText, X, AlertCircle, Loader2 } from 'lucide-react';
import {
  ALLOWED_EXTENSIONS,
  formatFileSize,
  MAX_FILE_SIZE_MB,
  validateContractFile,
} from '../utils/fileValidation';
import type { FullSecurityReport } from '../server/security/types';
import type { DecisionReport } from '../server/decision/types';
import { interpretUploadResponse, MESSAGES } from '../utils/uploadOutcome';

export interface UploadedContractFile {
  file: File;
  name: string;
  size: number;
  type: string;
  isScanning?: boolean;
  /** The Contract Decision Report returned by the single upload request. It is the only result the UI keeps. */
  decisionReport?: DecisionReport;
  /** Kept only so callers can tell that the file was rejected; never displayed. */
  securityReport?: FullSecurityReport;
}

interface ContractFileUploadProps {
  selectedFile: UploadedContractFile | null;
  onFileSelect: (file: UploadedContractFile | null) => void;
  /** A file (e.g. pasted contract text turned into a .txt file) to push through the full pipeline automatically. */
  autoStartFile?: File | null;
  onAutoStartConsumed?: () => void;
}

// Ensures a valid server-side HttpOnly session cookie exists
async function ensureSessionEstablished(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/session', { method: 'GET', credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

export const ContractFileUpload: React.FC<ContractFileUploadProps> = ({
  selectedFile,
  onFileSelect,
  autoStartFile,
  onAutoStartConsumed,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isReviewing, setIsReviewing] = useState(false);

  // Initialize secure session cookie on component mount
  useEffect(() => {
    void ensureSessionEstablished();
  }, []);

  // Pasted contract text arrives as a .txt file and goes through exactly the same request.
  const autoStartedRef = useRef<File | null>(null);
  useEffect(() => {
    // The ref guard keeps React StrictMode's double-invoked effects from uploading the file twice.
    if (autoStartFile && autoStartedRef.current !== autoStartFile) {
      autoStartedRef.current = autoStartFile;
      onAutoStartConsumed?.();
      void handleFiles([autoStartFile]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartFile]);

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const validation = validateContractFile(file);
    if (!validation.valid) {
      setErrorMessage(validation.error || MESSAGES.generic);
      return;
    }

    setErrorMessage(null);
    setIsReviewing(true);
    const base: UploadedContractFile = {
      file,
      name: file.name,
      size: file.size,
      type: file.type || file.name.split('.').pop()?.toUpperCase() || 'FILE',
      isScanning: true,
    };
    onFileSelect(base);

    try {
      await ensureSessionEstablished();
      const formData = new FormData();
      formData.append('file', file);

      // ONE request: the server checks the file, analyses it, returns the report and deletes the file again.
      const res = await fetch('/api/contracts/upload?analyze=1', { method: 'POST', credentials: 'same-origin', body: formData });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null; // not JSON (for example a platform error page)
      }

      const outcome = interpretUploadResponse(res.status, body);
      if (outcome.ok) {
        onFileSelect({ ...base, isScanning: false, decisionReport: outcome.report });
      } else {
        // Rejected or failed: one short message, and nothing from the checks is shown.
        onFileSelect({ ...base, isScanning: false });
        setErrorMessage(outcome.message);
      }
    } catch {
      onFileSelect({ ...base, isScanning: false });
      setErrorMessage(MESSAGES.unreachable);
    } finally {
      setIsReviewing(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    void handleFiles(e.dataTransfer.files);
  };
  const handleBrowseClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };
  const handleRemoveFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    setErrorMessage(null);
    onFileSelect(null);
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_EXTENSIONS.join(',')}
        onChange={(e) => void handleFiles(e.target.files)}
        className="hidden"
        aria-label="Upload contract file"
      />

      {isReviewing ? (
        <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-[16px] border border-[#E5E7EB] bg-[#FAFAFA] p-4">
          <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Reviewing your contract</p>
            {selectedFile && <p className="text-xs text-gray-500 truncate" title={selectedFile.name}>{selectedFile.name}</p>}
          </div>
        </div>
      ) : selectedFile?.decisionReport ? (
        <div className="flex items-center justify-between gap-3 rounded-[16px] border border-[#E5E7EB] bg-[#FAFAFA] p-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText className="w-4 h-4 text-gray-500 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate" title={selectedFile.name}>{selectedFile.name}</p>
              <p className="text-xs text-gray-500">{formatFileSize(selectedFile.size)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button type="button" onClick={handleBrowseClick} className="text-xs text-blue-700 hover:text-blue-800 hover:underline cursor-pointer">
              Review another
            </button>
            <button type="button" onClick={handleRemoveFile} title="Clear" aria-label="Clear the review" className="p-1 text-gray-400 hover:text-gray-600 rounded-md cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={handleBrowseClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleBrowseClick();
            }
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed px-4 py-8 text-center cursor-pointer transition-colors ${
            isDragging ? 'border-blue-400 bg-blue-50' : 'border-[#D1D5DB] bg-[#FAFAFA] hover:border-blue-300 hover:bg-white'
          }`}
        >
          <UploadCloud className="w-7 h-7 text-gray-400" aria-hidden="true" />
          <p className="text-sm font-medium text-gray-900">Drop your contract here, or click to choose a file</p>
          <p className="text-xs text-gray-500">PDF, DOCX or TXT · up to {MAX_FILE_SIZE_MB} MB</p>
        </div>
      )}

      {errorMessage && (
        <div role="alert" className="flex items-start gap-2 rounded-[12px] border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
};
