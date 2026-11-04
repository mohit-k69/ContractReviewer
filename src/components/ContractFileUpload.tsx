import React, { useRef, useState, useEffect } from 'react';
import {
  UploadCloud,
  FileText,
  X,
  AlertCircle,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  ALLOWED_EXTENSIONS,
  formatFileSize,
  MAX_FILE_SIZE_MB,
  validateContractFile,
} from '../utils/fileValidation';
import { FullSecurityReport, SecurityStatus } from '../server/security/types';

export interface UploadedContractFile {
  file: File;
  name: string;
  size: number;
  type: string;
  securityReport?: FullSecurityReport;
  isScanning?: boolean;
}

interface ContractFileUploadProps {
  selectedFile: UploadedContractFile | null;
  onFileSelect: (file: UploadedContractFile | null) => void;
}

function getSessionId(): string {
  let id = sessionStorage.getItem('contract_reviewer_session_id');
  if (!id) {
    id = `sess-${Math.random().toString(36).substring(2, 11)}-${Date.now()}`;
    sessionStorage.setItem('contract_reviewer_session_id', id);
  }
  return id;
}

export const ContractFileUpload: React.FC<ContractFileUploadProps> = ({
  selectedFile,
  onFileSelect,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [showSecurityDetails, setShowSecurityDetails] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const validation = validateContractFile(file);

    if (!validation.valid) {
      setErrorMessage(validation.error || 'Invalid file.');
      return;
    }

    setErrorMessage(null);
    setIsScanning(true);

    const initialFileData: UploadedContractFile = {
      file,
      name: file.name,
      size: file.size,
      type: file.type || file.name.split('.').pop()?.toUpperCase() || 'FILE',
      isScanning: true,
    };
    onFileSelect(initialFileData);

    // Send to backend security inspection pipeline
    try {
      const formData = new FormData();
      formData.append('file', file);

      const sessionId = getSessionId();
      const res = await fetch('/api/contracts/upload', {
        method: 'POST',
        headers: {
          'x-session-id': sessionId,
        },
        body: formData,
      });

      const report: FullSecurityReport = await res.json();

      setIsScanning(false);
      onFileSelect({
        ...initialFileData,
        securityReport: report,
        isScanning: false,
      });

      if (!report.eligibleForContractProcessing) {
        setErrorMessage(
          report.statusMessage || `Security inspection decision: ${report.status}`
        );
      }
    } catch (err: any) {
      setIsScanning(false);
      setErrorMessage('Security inspection service unreachable (Fail-Closed).');
      onFileSelect({
        ...initialFileData,
        isScanning: false,
      });
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
    handleFiles(e.dataTransfer.files);
  };

  const handleBrowseClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleRemoveFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedFile?.securityReport?.fileId) {
      try {
        await fetch(`/api/contracts/${selectedFile.securityReport.fileId}`, {
          method: 'DELETE',
          headers: { 'x-session-id': getSessionId() },
        });
      } catch {
        // Continue cleanup
      }
    }
    setErrorMessage(null);
    setShowSecurityDetails(false);
    onFileSelect(null);
  };

  const report = selectedFile?.securityReport;
  const isClean = report?.status === 'CLEAN_NO_KNOWN_THREATS';
  const hasThreat =
    report?.status === 'THREAT_DETECTED' ||
    report?.status === 'REJECTED' ||
    report?.status === 'SUSPICIOUS' ||
    report?.status === 'SCAN_FAILED';

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
        <div className="flex flex-col gap-2.5 p-3.5 rounded-[16px] border border-[#E5E7EB] bg-[#FAFAFA] transition-all">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2.5 overflow-hidden">
              <div
                className={`p-2 rounded-lg shrink-0 mt-0.5 ${
                  isScanning
                    ? 'bg-blue-50 text-blue-600 animate-pulse'
                    : isClean
                    ? 'bg-emerald-50 text-emerald-600'
                    : hasThreat
                    ? 'bg-rose-50 text-rose-600'
                    : 'bg-blue-50 text-blue-600'
                }`}
              >
                {isScanning ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isClean ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                ) : hasThreat ? (
                  <ShieldAlert className="w-4 h-4 text-rose-600" />
                ) : (
                  <FileText className="w-4 h-4" aria-hidden="true" />
                )}
              </div>
              <div className="flex flex-col min-w-0">
                <span
                  className="text-xs font-medium text-gray-900 truncate"
                  title={selectedFile.name}
                >
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
              className="p-1 text-gray-400 hover:text-gray-600 rounded-md transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Security Inspection Status */}
          <div className="pt-2 border-t border-gray-200/60 flex flex-col gap-1.5">
            {isScanning && (
              <div className="flex items-center gap-1.5 text-[11px] text-blue-600 font-medium">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Running security & malware inspection...</span>
              </div>
            )}

            {!isScanning && isClean && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-emerald-700 font-medium flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                    Clean (No known threats)
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowSecurityDetails(!showSecurityDetails)}
                    className="text-[10px] text-gray-500 hover:text-gray-700 flex items-center gap-0.5 cursor-pointer"
                  >
                    <span>Inspection details</span>
                    {showSecurityDetails ? (
                      <ChevronUp className="w-3 h-3" />
                    ) : (
                      <ChevronDown className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <span className="text-[10px] text-gray-400">
                  Verified in {report?.scanDurationMs}ms • SHA-256: {report?.metadata.sha256.substring(0, 10)}...
                </span>
              </div>
            )}

            {!isScanning && hasThreat && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-rose-700 font-semibold flex items-center gap-1">
                    <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />
                    {report?.status}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowSecurityDetails(!showSecurityDetails)}
                    className="text-[10px] text-gray-500 hover:text-gray-700 flex items-center gap-0.5 cursor-pointer"
                  >
                    <span>View audit</span>
                    {showSecurityDetails ? (
                      <ChevronUp className="w-3 h-3" />
                    ) : (
                      <ChevronDown className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <span className="text-[10px] text-rose-600 leading-tight">
                  {report?.statusMessage}
                </span>
              </div>
            )}

            {/* Expandable audit breakdown */}
            {showSecurityDetails && report && (
              <div className="mt-1 p-2.5 rounded-[12px] bg-white border border-[#E5E7EB] text-[10px] flex flex-col gap-1.5 text-gray-600">
                <div className="flex items-center justify-between">
                  <span>Authenticity & Signature:</span>
                  <span className={report.authenticity.passed ? 'text-emerald-600 font-medium' : 'text-rose-600 font-semibold'}>
                    {report.authenticity.passed ? 'Verified' : 'Failed'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Structure & Zip Bomb:</span>
                  <span className={report.structure.passed ? 'text-emerald-600 font-medium' : 'text-rose-600 font-semibold'}>
                    {report.structure.passed ? 'Safe' : 'Failed'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Active Content / Macros:</span>
                  <span className={report.activeContent.passed ? 'text-emerald-600 font-medium' : 'text-rose-600 font-semibold'}>
                    {report.activeContent.passed ? 'None Detected' : 'Blocked'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Malware Scanner:</span>
                  <span className={report.malware.passed ? 'text-emerald-600 font-medium' : 'text-rose-600 font-semibold'}>
                    {report.malware.passed ? 'Clean' : 'Threat Found'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Prompt Injection Defense:</span>
                  <span className={report.promptInjection.passed ? 'text-emerald-600 font-medium' : 'text-amber-600 font-semibold'}>
                    {report.promptInjection.passed ? 'Clean' : 'Suspicious'}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end pt-1">
              <button
                type="button"
                onClick={handleBrowseClick}
                className="text-[11px] text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
              >
                Replace file
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Dropzone / Upload area */
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleBrowseClick}
          className={`flex flex-col items-center justify-center text-center p-6 rounded-[16px] border-2 border-dashed transition-all cursor-pointer ${
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
            className="mt-3 px-3.5 py-1.5 rounded-[13px] border border-[#E5E7EB] bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-100"
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
          className="flex items-start gap-1.5 p-2.5 rounded-[12px] bg-red-50 border border-red-200 text-red-700 text-xs mt-1"
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-500" aria-hidden="true" />
          <span className="leading-tight">{errorMessage}</span>
        </div>
      )}
    </div>
  );
};
