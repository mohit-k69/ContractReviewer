/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { ContractTypeSelector } from './components/ContractTypeSelector';
import { ContractInput } from './components/ContractInput';
import { InputMethodSelector, InputMethod } from './components/InputMethodSelector';
import { ContractFileUpload, UploadedContractFile } from './components/ContractFileUpload';
import { ContractReview } from './components/review/ContractReview';
import { DEFAULT_CONTRACT_TYPE_ID } from './utils/contractTypes';

export default function App() {
  const [contractType, setContractType] = useState<string>(DEFAULT_CONTRACT_TYPE_ID);
  const [inputMethod, setInputMethod] = useState<InputMethod | null>(null);
  const [contractText, setContractText] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<UploadedContractFile | null>(null);

  const [pastedFile, setPastedFile] = useState<File | null>(null);

  const decisionReport = selectedFile?.decisionReport;

  // Pasted text becomes a .txt file that goes through the same single-request review as an uploaded file.
  const handlePasteSubmit = (text: string) => {
    const file = new File([text], 'pasted-contract.txt', { type: 'text/plain' });
    setSelectedFile(null);
    setInputMethod('upload');
    setPastedFile(file);
  };

  return (
    <div className="min-h-screen bg-[#FDFDFD] text-gray-900 antialiased p-6 sm:p-8 lg:p-10">
      <div
        className={`w-full flex flex-col lg:flex-row items-start gap-8 transition-all duration-300 ${
          decisionReport ? 'max-w-7xl mx-auto' : ''
        }`}
      >
        {/* Left panel. The whole form group is centred in the available height (and horizontally within the panel);
            beside a report on large screens it stays centred in the viewport while the report scrolls. */}
        <main
          className={`w-full lg:w-[420px] lg:shrink-0 flex flex-col justify-center lg:sticky lg:top-10 lg:h-[calc(100svh-5rem)] ${
            decisionReport ? '' : 'min-h-[calc(100svh-3rem)] sm:min-h-[calc(100svh-4rem)] lg:min-h-0'
          }`}
        >
          <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-8">
            {/* Once a review is shown, the selectors step aside on small screens so the agreement name comes first. */}
            <div className={decisionReport ? 'hidden lg:block' : ''}>
              <ContractTypeSelector value={contractType} onChange={setContractType} />
            </div>

            <div className="flex flex-col gap-6">
              <div className={decisionReport ? 'hidden lg:block' : ''}>
                <InputMethodSelector selectedMethod={inputMethod} onSelectMethod={setInputMethod} />
              </div>

              {/* Paste text or file upload */}
              {inputMethod === 'paste' && (
                <ContractInput value={contractText} onChange={setContractText} onSubmit={handlePasteSubmit} />
              )}

              {inputMethod === 'upload' && (
                <ContractFileUpload
                  selectedFile={selectedFile}
                  onFileSelect={setSelectedFile}
                  autoStartFile={pastedFile}
                  onAutoStartConsumed={() => setPastedFile(null)}
                />
              )}
            </div>
          </div>
        </main>

        {/* The Contract Decision Report (the only result shown) */}
        {decisionReport && (
          <section className="w-full flex-1 min-w-0" aria-label="Contract review report">
            <ContractReview key={decisionReport.generated_at} report={decisionReport} fileName={selectedFile?.name} />
          </section>
        )}
      </div>
    </div>
  );
}
