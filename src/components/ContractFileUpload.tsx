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
  CheckCircle2,
  Layers,
  AlertTriangle,
  Table,
  Sparkles,
} from 'lucide-react';
import {
  ALLOWED_EXTENSIONS,
  formatFileSize,
  MAX_FILE_SIZE_MB,
  validateContractFile,
} from '../utils/fileValidation';
import { FullSecurityReport } from '../server/security/types';
import { DocumentExtractionResult, ExtractedBlock } from '../server/extraction/types';
import { NormalizedDocument } from '../server/normalization/types';
import { ContractUnderstandingResult } from '../server/understanding/types';

export interface UploadedContractFile {
  file: File;
  name: string;
  size: number;
  type: string;
  securityReport?: FullSecurityReport;
  isScanning?: boolean;
  extractionResult?: DocumentExtractionResult;
  isExtracting?: boolean;
  normalizedDocument?: NormalizedDocument;
  isNormalizing?: boolean;
  understandingResult?: ContractUnderstandingResult;
  isUnderstanding?: boolean;
}

interface ContractFileUploadProps {
  selectedFile: UploadedContractFile | null;
  onFileSelect: (file: UploadedContractFile | null) => void;
}

// Ensures a valid server-side HttpOnly session cookie exists
async function ensureSessionEstablished(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
    });
    return res.ok;
  } catch {
    return false;
  }
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
  const [isExtracting, setIsExtracting] = useState(false);
  const [showExtractionBlocks, setShowExtractionBlocks] = useState(false);
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [showStructureInspector, setShowStructureInspector] = useState(true);
  const [isUnderstanding, setIsUnderstanding] = useState(false);

  // Initialize secure session cookie on component mount
  useEffect(() => {
    ensureSessionEstablished();
  }, []);

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

    try {
      await ensureSessionEstablished();

      const formData = new FormData();
      formData.append('file', file);

      // Authenticated purely via HttpOnly cookie (credentials: 'same-origin')
      const res = await fetch('/api/contracts/upload', {
        method: 'POST',
        credentials: 'same-origin',
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
          credentials: 'same-origin',
        });
      } catch {
        // Continue cleanup
      }
    }
    setErrorMessage(null);
    setShowSecurityDetails(false);
    setShowExtractionBlocks(false);
    onFileSelect(null);
  };

  const handleReviewContract = async () => {
    if (!selectedFile?.securityReport?.fileId) return;
    const fileId = selectedFile.securityReport.fileId;

    setIsExtracting(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/contracts/${fileId}/extract`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Extraction failed with HTTP ${res.status}`);
      }

      const extractionResult: DocumentExtractionResult = await res.json();
      setIsExtracting(false);

      // Auto-trigger Phase 2B normalization
      setIsNormalizing(true);
      let normalizedDocument: NormalizedDocument | undefined;
      try {
        const normRes = await fetch(`/api/contracts/${fileId}/normalize`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
        });
        if (normRes.ok) {
          normalizedDocument = await normRes.json();
        }
      } catch {
        // Continue gracefully
      } finally {
        setIsNormalizing(false);
      }

      // Auto-trigger Phase 2C understanding if normalized
      setIsUnderstanding(true);
      let understandingResult: ContractUnderstandingResult | undefined;
      if (normalizedDocument) {
        try {
          const undRes = await fetch(`/api/contracts/${fileId}/understand`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
          });
          if (undRes.ok) {
            understandingResult = await undRes.json();
          }
        } catch {
          // Continue gracefully
        } finally {
          setIsUnderstanding(false);
        }
      }

      onFileSelect({
        ...selectedFile,
        extractionResult,
        isExtracting: false,
        normalizedDocument,
        isNormalizing: false,
        understandingResult,
        isUnderstanding: false,
      });
    } catch (err: any) {
      setIsExtracting(false);
      setIsNormalizing(false);
      setIsUnderstanding(false);
      setErrorMessage(err.message || 'Failed to extract contract content.');
    }
  };

  const handleNormalizeContract = async () => {
    if (!selectedFile?.securityReport?.fileId) return;
    const fileId = selectedFile.securityReport.fileId;
    setIsNormalizing(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/contracts/${fileId}/normalize`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Normalization failed with HTTP ${res.status}`);
      }

      const normalizedDocument: NormalizedDocument = await res.json();
      setIsNormalizing(false);
      onFileSelect({
        ...selectedFile,
        normalizedDocument,
        isNormalizing: false,
      });
    } catch (err: any) {
      setIsNormalizing(false);
      setErrorMessage(err.message || 'Failed to normalize contract structure.');
    }
  };

  const handleUnderstandContract = async () => {
    if (!selectedFile?.securityReport?.fileId) return;
    const fileId = selectedFile.securityReport.fileId;
    setIsUnderstanding(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/contracts/${fileId}/understand`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Understanding analysis failed with HTTP ${res.status}`);
      }

      const understandingResult: ContractUnderstandingResult = await res.json();
      setIsUnderstanding(false);
      onFileSelect({
        ...selectedFile,
        understandingResult,
        isUnderstanding: false,
      });
    } catch (err: any) {
      setIsUnderstanding(false);
      setErrorMessage(err.message || 'Failed to analyze contract understanding.');
    }
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
        <div className="flex flex-col gap-2 w-full">
          {/* Selected file card */}
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

        {/* Phase 2A Review Trigger & Extraction Result */}
        {isClean && report?.eligibleForContractProcessing && (
          <div className="flex flex-col gap-2 mt-1">
            {!selectedFile.extractionResult && (
              <button
                type="button"
                onClick={handleReviewContract}
                disabled={isExtracting}
                className="w-full h-11 rounded-[14px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-400 text-white font-medium text-xs tracking-tight transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm disabled:cursor-not-allowed"
              >
                {isExtracting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                    <span>Extracting readable content...</span>
                  </>
                ) : (
                  <>
                    <FileText className="w-4 h-4 text-white" />
                    <span>Review Contract</span>
                  </>
                )}
              </button>
            )}

            {isExtracting && (
              <div className="text-[11px] text-gray-500 text-center py-1">
                Verifying cryptographic integrity & extracting structure...
              </div>
            )}

            {selectedFile.extractionResult && (
              <div className="flex flex-col gap-2 p-3.5 rounded-[16px] border border-[#E5E7EB] bg-[#FAFAFA]">
                {/* Status Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {selectedFile.extractionResult.extraction_status === 'COMPLETED' ? (
                      <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 shrink-0">
                        <CheckCircle2 className="w-4 h-4" />
                      </div>
                    ) : selectedFile.extractionResult.extraction_status === 'OCR_REQUIRED' ||
                      selectedFile.extractionResult.extraction_status === 'PARTIAL' ? (
                      <div className="p-1.5 rounded-lg bg-amber-50 text-amber-600 shrink-0">
                        <AlertTriangle className="w-4 h-4" />
                      </div>
                    ) : (
                      <div className="p-1.5 rounded-lg bg-rose-50 text-rose-600 shrink-0">
                        <AlertCircle className="w-4 h-4" />
                      </div>
                    )}

                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-semibold text-gray-900">
                        {selectedFile.extractionResult.extraction_status === 'COMPLETED'
                          ? 'Extraction Complete'
                          : selectedFile.extractionResult.extraction_status === 'OCR_REQUIRED'
                          ? 'OCR Required'
                          : selectedFile.extractionResult.extraction_status === 'PARTIAL'
                          ? 'Partial Extraction'
                          : 'Extraction Failed'}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {selectedFile.extractionResult.total_blocks} blocks •{' '}
                        {selectedFile.extractionResult.extraction_duration_ms}ms
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowExtractionBlocks(!showExtractionBlocks)}
                    className="text-[11px] text-blue-600 hover:text-blue-700 flex items-center gap-0.5 cursor-pointer font-medium"
                  >
                    <span>{showExtractionBlocks ? 'Hide' : 'View'}</span>
                    {showExtractionBlocks ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Status Notice */}
                {selectedFile.extractionResult.extraction_status === 'OCR_REQUIRED' && (
                  <div className="p-2.5 rounded-[12px] bg-amber-50/70 border border-amber-200 text-amber-800 text-[11px] leading-relaxed">
                    This document appears to be scanned or image-based. Optical Character Recognition (OCR) is required to read text content.
                  </div>
                )}

                {selectedFile.extractionResult.warnings.length > 0 && (
                  <div className="flex flex-col gap-1 text-[10px] text-amber-700 bg-amber-50/50 p-2 rounded-[10px] border border-amber-100">
                    {selectedFile.extractionResult.warnings.map((w, idx) => (
                      <span key={idx} className="leading-tight">• {w}</span>
                    ))}
                  </div>
                )}

                {/* Expandable Document Structure Blocks */}
                {showExtractionBlocks && (
                  <div className="flex flex-col gap-2 mt-1 max-h-[360px] overflow-y-auto pr-0.5">
                    {selectedFile.extractionResult.blocks.length === 0 ? (
                      <div className="text-[11px] text-gray-400 text-center py-4">
                        No structural blocks to display.
                      </div>
                    ) : (
                      selectedFile.extractionResult.blocks.map((block) => (
                        <div
                          key={block.block_id}
                          className="p-2.5 rounded-[12px] bg-white border border-[#E5E7EB] text-left text-xs flex flex-col gap-1"
                        >
                          <div className="flex items-center justify-between text-[9px] text-gray-400 font-mono">
                            <span className="uppercase tracking-wider font-semibold text-gray-500">
                              {block.type} {block.metadata?.heading_level ? `H${block.metadata.heading_level}` : ''}
                            </span>
                            <span>{block.structural_ref || block.block_id}</span>
                          </div>

                          {block.type === 'heading' ? (
                            <div className="font-semibold text-gray-900 text-xs border-l-2 border-blue-500 pl-2">
                              {block.text}
                            </div>
                          ) : block.type === 'list' ? (
                            <div className="text-[11px] text-gray-800 pl-2 leading-relaxed">
                              • {block.text.replace(/^[-*•]\s+/, '')}
                            </div>
                          ) : block.type === 'table' && block.table_data ? (
                            <div className="overflow-x-auto my-1 border border-gray-100 rounded">
                              <table className="min-w-full text-[10px] divide-y divide-gray-200">
                                <tbody className="divide-y divide-gray-100">
                                  {block.table_data.map((row, rIdx) => (
                                    <tr key={rIdx} className={rIdx === 0 ? 'bg-gray-50 font-medium' : ''}>
                                      {row.map((cell, cIdx) => (
                                        <td key={cIdx} className="px-2 py-1 text-gray-700 whitespace-nowrap">
                                          {cell}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <div className="text-[11px] text-gray-700 leading-relaxed">
                              {block.text}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between pt-1 border-t border-gray-200/60 text-[10px] text-gray-400">
                  <span>SHA-256 Verified Match</span>
                  <button
                    type="button"
                    onClick={handleReviewContract}
                    disabled={isExtracting}
                    className="text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
                  >
                    Re-extract
                  </button>
                </div>
              </div>
            )}

            {/* Phase 2B Document Structure Inspector */}
            {selectedFile.normalizedDocument && (
              <div className="flex flex-col gap-2 p-3.5 rounded-[16px] border border-[#E5E7EB] bg-[#FAFAFA] mt-1">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-indigo-50 text-indigo-600 shrink-0">
                      <Layers className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-semibold text-gray-900">
                        Document Structure Inspector
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {selectedFile.normalizedDocument.total_sections} sections •{' '}
                        {selectedFile.normalizedDocument.total_clauses} clauses •{' '}
                        {selectedFile.normalizedDocument.total_paragraphs} paragraphs
                        {selectedFile.normalizedDocument.total_tables > 0
                          ? ` • ${selectedFile.normalizedDocument.total_tables} tables`
                          : ''}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowStructureInspector(!showStructureInspector)}
                    className="text-[11px] text-blue-600 hover:text-blue-700 flex items-center gap-0.5 cursor-pointer font-medium"
                    aria-label="Toggle document structure inspector"
                  >
                    <span>{showStructureInspector ? 'Hide' : 'Inspect'}</span>
                    {showStructureInspector ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Normalized hierarchy display */}
                {showStructureInspector && (
                  <div className="flex flex-col gap-2 mt-1 max-h-[420px] overflow-y-auto pr-0.5 text-xs">
                    {/* Unclassified / Preamble blocks */}
                    {selectedFile.normalizedDocument.unclassified_blocks.length > 0 && (
                      <div className="p-2.5 rounded-[12px] bg-amber-50/50 border border-amber-200/60 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between text-[9px] font-mono text-amber-700 font-semibold uppercase tracking-wider">
                          <span>Preamble / Document Elements ({selectedFile.normalizedDocument.unclassified_blocks.length})</span>
                        </div>
                        {selectedFile.normalizedDocument.unclassified_blocks.map((block) => (
                          <NormalizedNodeRenderer key={block.id} node={block} />
                        ))}
                      </div>
                    )}

                    {/* Sections and recursive hierarchy */}
                    {selectedFile.normalizedDocument.sections.map((section) => (
                      <NormalizedNodeRenderer key={section.id} node={section} />
                    ))}
                  </div>
                )}

                {/* Normalized status footer */}
                <div className="flex items-center justify-between pt-1 border-t border-gray-200/60 text-[10px] text-gray-400">
                  <span>Normalized: {selectedFile.normalizedDocument.normalization_status}</span>
                  <button
                    type="button"
                    onClick={handleNormalizeContract}
                    disabled={isNormalizing}
                    className="text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
                  >
                    {isNormalizing ? 'Normalizing...' : 'Re-normalize'}
                  </button>
                </div>
              </div>
            )}

            {/* Phase 2C Understanding Status / Action Card */}
            {selectedFile.normalizedDocument && (
              selectedFile.understandingResult ? (
                <div className="flex flex-col gap-2 p-3.5 rounded-[16px] border border-indigo-100 bg-indigo-50/40 mt-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-lg bg-indigo-600 text-white shrink-0">
                        <Sparkles className="w-4 h-4" />
                      </div>
                      <div className="flex flex-col min-w-0 text-left">
                        <span className="text-xs font-semibold text-gray-900 truncate">
                          {selectedFile.understandingResult.classification?.category || 'Contract Understanding'}
                        </span>
                        <span className="text-[10px] text-indigo-700 font-medium">
                          {selectedFile.understandingResult.stats.verification_percentage}% Verbatim Evidence Match
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={handleUnderstandContract}
                      disabled={isUnderstanding}
                      className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
                    >
                      {isUnderstanding ? 'Analyzing...' : 'Re-analyze'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={handleUnderstandContract}
                    disabled={isUnderstanding}
                    className="w-full h-11 rounded-[14px] bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:bg-indigo-400 text-white font-medium text-xs tracking-tight transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm disabled:cursor-not-allowed"
                  >
                    {isUnderstanding ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-white" />
                        <span>Understanding contract with Gemini...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 text-white" />
                        <span>Understand Contract (Gemini AI)</span>
                      </>
                    )}
                  </button>
                </div>
              )
            )}
          </div>
        )}
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

interface NormalizedNodeRendererProps {
  node: any;
  depth?: number;
}

function NormalizedNodeRenderer({ node, depth = 0 }: NormalizedNodeRendererProps) {
  if (!node) return null;

  if (node.type === 'section' || node.type === 'subsection') {
    const isSubsection = node.type === 'subsection';
    return (
      <div
        key={node.id}
        className={`p-2.5 rounded-[12px] ${
          isSubsection
            ? 'bg-slate-50/60 border border-slate-200/80 ml-2 mt-1'
            : 'bg-white border border-[#E5E7EB] mt-1'
        } flex flex-col gap-2 text-left`}
      >
        <div className="flex items-center justify-between">
          <span className="font-semibold text-xs text-gray-900 flex items-center gap-1.5">
            {node.section_number && (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${
                  isSubsection ? 'bg-indigo-50 text-indigo-700' : 'bg-blue-50 text-blue-700'
                }`}
              >
                {node.section_number}
              </span>
            )}
            <span>{node.title || node.text}</span>
          </span>
          <span className="text-[9px] text-gray-400 font-mono">{node.id}</span>
        </div>

        {node.children && node.children.length > 0 && (
          <div className="flex flex-col gap-1.5 pl-2 border-l-2 border-gray-200/60">
            {node.children.map((child: any) => (
              <NormalizedNodeRenderer key={child.id} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (node.type === 'clause' || node.type === 'subclause') {
    const isSubclause = node.type === 'subclause';
    return (
      <div
        key={node.id}
        className={`p-2 rounded-[8px] ${
          isSubclause
            ? 'bg-white/90 border border-indigo-200/60 ml-2 shadow-xs'
            : 'bg-gray-50/80 border border-gray-200/60'
        } flex flex-col gap-1 text-left`}
      >
        <div className="flex items-center justify-between text-[10px]">
          <span className="font-medium text-gray-900 flex items-center gap-1">
            {node.clause_number && (
              <span
                className={`font-mono font-semibold ${
                  isSubclause ? 'text-purple-700' : 'text-indigo-700'
                }`}
              >
                {node.clause_number}
              </span>
            )}
            {node.title && <span>{node.title}</span>}
          </span>
          <span className="text-[9px] text-gray-400 font-mono">{node.id}</span>
        </div>

        {/* Clause text (rendered once, no visual duplication) */}
        <div className="text-[11px] text-gray-700 leading-relaxed">{node.text}</div>

        {/* Recursively render nested subclauses, paragraphs, tables, or lists */}
        {node.content && node.content.length > 0 && (
          <div className="flex flex-col gap-1 pl-2 border-l-2 border-indigo-100/70 mt-1">
            {node.content.map((child: any) => (
              <NormalizedNodeRenderer key={child.id} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (node.type === 'table') {
    return (
      <div
        key={node.id}
        className="overflow-x-auto my-1 border border-gray-200 rounded-[8px] bg-white p-1 text-left"
      >
        <div className="text-[9px] text-gray-400 font-mono px-1 pb-1">
          {node.id} • Table ({node.row_count} rows, {node.col_count} cols)
        </div>
        <table className="min-w-full text-[10px] divide-y divide-gray-200">
          <tbody className="divide-y divide-gray-100">
            {node.table_data?.map((row: string[], rIdx: number) => (
              <tr key={rIdx} className={rIdx === 0 ? 'bg-gray-50 font-medium' : ''}>
                {row.map((cell: string, cIdx: number) => (
                  <td key={cIdx} className="px-2 py-1 text-gray-700 whitespace-nowrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (node.type === 'list') {
    return (
      <div
        key={node.id}
        className="p-2 rounded-[8px] bg-gray-50/50 border border-gray-100 flex flex-col gap-1 text-left"
      >
        <div className="text-[9px] text-gray-400 font-mono">{node.id} • List</div>
        {node.items?.map((item: any) => (
          <div key={item.id} className="text-[11px] text-gray-700 pl-1">
            • {item.text.replace(/^[-*•]\s+/, '')}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div key={node.id} className="text-[11px] text-gray-700 py-0.5 text-left">
      {node.text}
    </div>
  );
}
