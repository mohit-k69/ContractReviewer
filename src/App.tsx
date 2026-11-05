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
import { EmptyReviewState } from './components/EmptyReviewState';
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
    // One workspace, two areas: on the left you provide the contract, on the right you understand it. A hairline divider
    // and an almost invisible tint on the left mark the two areas, and both stay in place once the review appears.
    <div className="min-h-screen bg-[#FDFDFD] text-gray-900 antialiased lg:flex">
      {/* Left: where the contract is provided. The form group is centred in the viewport and stays centred while a
          long review scrolls beside it. */}
      <main
        className={`w-full border-[#ECEEF2] lg:w-[460px] lg:shrink-0 lg:border-b-0 lg:border-r lg:bg-[#F9FAFB] px-6 sm:px-8 lg:px-10 ${
          decisionReport ? 'border-b bg-[#F9FAFB] py-6' : 'flex min-h-svh items-center py-8 lg:min-h-0 lg:py-0'
        }`}
      >
        <div className="flex w-full items-center lg:sticky lg:top-0 lg:h-screen">
          <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-9">
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
        </div>
      </main>

      {/* Right: where the contract is understood */}
      {!decisionReport && (
        <section aria-label="Review preview" className="hidden min-w-0 flex-1 items-center justify-center px-12 lg:flex lg:h-screen">
          <EmptyReviewState busy={Boolean(selectedFile?.isScanning)} />
        </section>
      )}

      {decisionReport && (
        <section className="flex min-w-0 flex-1 justify-center px-6 py-8 sm:px-8 lg:px-12 lg:py-10" aria-label="Contract review report">
          <ContractReview key={decisionReport.generated_at} report={decisionReport} fileName={selectedFile?.name} />
        </section>
      )}
    </div>
  );
}
