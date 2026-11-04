/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { ContractTypeSelector } from './components/ContractTypeSelector';
import { ContractInput } from './components/ContractInput';
import { InputMethodSelector, InputMethod } from './components/InputMethodSelector';
import { ContractFileUpload, UploadedContractFile } from './components/ContractFileUpload';
import { ContractUnderstandingViewer } from './components/ContractUnderstandingViewer';
import { ContractReviewReport } from './components/ContractReviewReport';
import { DEFAULT_CONTRACT_TYPE_ID } from './utils/contractTypes';

export default function App() {
  const [contractType, setContractType] = useState<string>(DEFAULT_CONTRACT_TYPE_ID);
  const [inputMethod, setInputMethod] = useState<InputMethod | null>(null);
  const [contractText, setContractText] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<UploadedContractFile | null>(null);

  const [pastedFile, setPastedFile] = useState<File | null>(null);
  const [resultView, setResultView] = useState<'report' | 'facts'>('report');

  const hasUnderstanding = Boolean(selectedFile?.understandingResult);
  const hasReport = Boolean(selectedFile?.riskReport);

  // Pasted text becomes a .txt file that goes through the same security, extraction,
  // normalization, understanding and review-report pipeline as an uploaded file.
  const handlePasteSubmit = (text: string) => {
    const file = new File([text], 'pasted-contract.txt', { type: 'text/plain' });
    setSelectedFile(null);
    setResultView('report');
    setInputMethod('upload');
    setPastedFile(file);
  };

  return (
    <div className="min-h-screen bg-[#FDFDFD] text-gray-900 antialiased p-6 sm:p-8 lg:p-10">
      <div
        className={`w-full flex flex-col lg:flex-row items-start gap-8 transition-all duration-300 ${
          hasUnderstanding ? 'max-w-7xl mx-auto' : ''
        }`}
      >
        {/* Main controls column positioned on left side */}
        <main className="w-full lg:w-[380px] lg:shrink-0 flex flex-col gap-4">
          {/* 1. Contract Type Selector */}
          <ContractTypeSelector
            value={contractType}
            onChange={setContractType}
          />

          {/* 2. Contract Input Method Selection */}
          <InputMethodSelector
            selectedMethod={inputMethod}
            onSelectMethod={setInputMethod}
          />

          {/* 3. Conditional Input Area (Paste Text or File Upload) */}
          {inputMethod === 'paste' && (
            <ContractInput
              value={contractText}
              onChange={setContractText}
              onSubmit={handlePasteSubmit}
            />
          )}

          {inputMethod === 'upload' && (
            <ContractFileUpload
              selectedFile={selectedFile}
              onFileSelect={setSelectedFile}
              autoStartFile={pastedFile}
              onAutoStartConsumed={() => setPastedFile(null)}
            />
          )}
        </main>

        {/* Phase 3 Review Report (primary) and Phase 2C Contract Understanding (supporting facts) */}
        {hasUnderstanding && selectedFile?.understandingResult && (
          <section className="w-full flex-1 min-w-0 flex flex-col gap-4">
            {hasReport && (
              <div
                role="tablist"
                aria-label="Result view"
                className="inline-flex self-start rounded-full border border-[#E5E7EB] bg-[#FAFAFA] p-1 text-xs"
              >
                {([
                  ['report', 'Review report'],
                  ['facts', 'Extracted contract facts'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={resultView === id}
                    onClick={() => setResultView(id)}
                    className={`px-3.5 h-8 rounded-full font-medium transition-colors cursor-pointer ${
                      resultView === id
                        ? 'bg-white text-blue-700 shadow-xs ring-1 ring-blue-200'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {hasReport && resultView === 'report' && selectedFile.riskReport ? (
              <ContractReviewReport report={selectedFile.riskReport} />
            ) : (
              <ContractUnderstandingViewer result={selectedFile.understandingResult} />
            )}
          </section>
        )}
      </div>
    </div>
  );
}
