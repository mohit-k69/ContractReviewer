import React, { useRef, useState } from 'react';
import { UploadCloud, FileText, X, AlertCircle } from 'lucide-react';
import {
  ALLOWED_EXTENSIONS,
  formatFileSize,
  MAX_FILE_SIZE_MB,
  validateContractFile,
} from '../utils/fileValidation';

export interface UploadedContractFile {
  file: File;
  name: string;
  size: number;
  type: string;
}

interface ContractFileUploadProps {
  selectedFile: UploadedContractFile | null;
  onFileSelect: (file: UploadedContractFile | null) => void;
}

export const ContractFileUpload: React.FC<ContractFileUploadProps> = ({
  selectedFile,
  onFileSelect,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const validation = validateContractFile(file);

    if (!validation.valid) {
      setErrorMessage(validation.error || 'Invalid file.');
      return;
    }

    setErrorMessage(null);
    onFileSelect({
      file,
      name: file.name,
      size: file.size,
      type: file.type || file.name.split('.').pop()?.toUpperCase() || 'FILE',
    });
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
    handleFiles(e.dataTransfer.files);
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
    <div className="flex flex-col gap-2 w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_EXTENSIONS.join(',')}
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
        aria-label="Upload contract file"
      />

      {selectedFile ? (
        /* Selected file card */
        <div className="flex flex-col gap-2 p-3.5 rounded-md border border-[#E5E7EB] bg-[#FAFAFA]">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2.5 overflow-hidden">
              <div className="p-2 rounded bg-blue-50 text-blue-600 shrink-0 mt-0.5">
                <FileText className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-gray-900 truncate" title={selectedFile.name}>
                  {selectedFile.name}
                </span>
                <span className="text-[11px] text-gray-500 mt-0.5">
                  {formatFileSize(selectedFile.size)}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleRemoveFile}
              title="Remove file"
              aria-label="Remove selected file"
              className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-gray-200/60 mt-1">
            <span className="text-[11px] text-green-700 font-medium flex items-center gap-1">
              File ready for review
            </span>
            <button
              type="button"
              onClick={handleBrowseClick}
              className="text-[11px] text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
            >
              Replace file
            </button>
          </div>
        </div>
      ) : (
        /* Dropzone / Upload area */
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleBrowseClick}
          className={`flex flex-col items-center justify-center text-center p-6 rounded-md border-2 border-dashed transition-all cursor-pointer ${
            isDragging
              ? 'border-blue-400 bg-blue-50/40'
              : 'border-[#E5E7EB] bg-[#FAFAFA] hover:bg-white hover:border-gray-300'
          }`}
          role="button"
          tabIndex={0}
          aria-label="Upload contract drag and drop area"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleBrowseClick();
            }
          }}
        >
          <div className="p-2.5 rounded-full bg-gray-100 text-gray-500 mb-2">
            <UploadCloud className="w-5 h-5 text-gray-600" aria-hidden="true" />
          </div>

          <span className="text-xs font-semibold text-gray-900">
            Upload your contract
          </span>

          <span className="text-[11px] text-gray-500 mt-1 max-w-[240px] leading-relaxed">
            Drag and drop your file here, or browse your device.
          </span>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleBrowseClick();
            }}
            className="mt-3 px-3 py-1.5 rounded-md border border-[#E5E7EB] bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            Browse files
          </button>

          <div className="flex flex-col items-center gap-0.5 mt-3 pt-3 border-t border-gray-200/60 w-full text-[10px] text-gray-400">
            <span>Supported: PDF (.pdf), Word (.docx), Plain text (.txt)</span>
            <span>Maximum size: {MAX_FILE_SIZE_MB} MB</span>
          </div>
        </div>
      )}

      {/* Error message */}
      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-1.5 p-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs mt-1"
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-500" aria-hidden="true" />
          <span className="leading-tight">{errorMessage}</span>
        </div>
      )}
    </div>
  );
};
