/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { ContractTypeSelector } from './components/ContractTypeSelector';
import { ContractInput } from './components/ContractInput';
import { DEFAULT_CONTRACT_TYPE_ID } from './utils/contractTypes';

export default function App() {
  const [contractType, setContractType] = useState<string>(DEFAULT_CONTRACT_TYPE_ID);
  const [contractText, setContractText] = useState<string>('');

  return (
    <div className="min-h-screen bg-white text-gray-900 antialiased p-6 sm:p-8 lg:p-10">
      {/* 
        Main content container aligned to the left, occupying approx 20-25% of desktop viewport
        (min 320px, max 380px), expanding on mobile screens with appropriate padding.
        The remaining 75-80% of the page is kept clean and empty.
      */}
      <main className="w-full md:w-[24vw] md:min-w-[340px] md:max-w-[380px] flex flex-col gap-4">
        <ContractTypeSelector
          value={contractType}
          onChange={setContractType}
        />
        <ContractInput
          value={contractText}
          onChange={setContractText}
        />
      </main>
    </div>
  );
}
