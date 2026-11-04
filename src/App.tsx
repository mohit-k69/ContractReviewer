/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { ContractTypeSelector } from './components/ContractTypeSelector';
import { ContractInput } from './components/ContractInput';
import { InputMethodSelector, InputMethod } from './components/InputMethodSelector';
import { ContractFileUpload, UploadedContractFile } from './components/ContractFileUpload';
import { DEFAULT_CONTRACT_TYPE_ID } from './utils/contractTypes';

export default function App() {
  const [contractType, setContractType] = useState<string>(DEFAULT_CONTRACT_TYPE_ID);
  const [inputMethod, setInputMethod] = useState<InputMethod | null>(null);
  const [contractText, setContractText] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<UploadedContractFile | null>(null);

  return (
    <div className="min-h-screen bg-white text-gray-900 antialiased p-6 sm:p-8 lg:p-10">
      {/* 
        Main content container positioned on the left side (approx 20-25% desktop viewport width,
        340-380px), expanding responsively on mobile. The remaining 75-80% is left empty.
      */}
      <main className="w-full md:w-[24vw] md:min-w-[340px] md:max-w-[380px] flex flex-col gap-4">
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
    </div>
  );
}
