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
import { DEFAULT_CONTRACT_TYPE_ID } from './utils/contractTypes';

export default function App() {
  const [contractType, setContractType] = useState<string>(DEFAULT_CONTRACT_TYPE_ID);
  const [inputMethod, setInputMethod] = useState<InputMethod | null>(null);
  const [contractText, setContractText] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<UploadedContractFile | null>(null);

  const hasUnderstanding = Boolean(selectedFile?.understandingResult);

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
            />
          )}

          {inputMethod === 'upload' && (
            <ContractFileUpload
              selectedFile={selectedFile}
              onFileSelect={setSelectedFile}
            />
          )}
        </main>

        {/* Phase 2C Contract Understanding Viewer */}
        {hasUnderstanding && selectedFile?.understandingResult && (
          <section className="w-full flex-1 min-w-0 flex flex-col gap-4">
            <ContractUnderstandingViewer
              result={selectedFile.understandingResult}
            />
          </section>
        )}
      </div>
    </div>
  );
}
