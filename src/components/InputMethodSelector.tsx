import React from 'react';
import { Clipboard, UploadCloud } from 'lucide-react';

export type InputMethod = 'paste' | 'upload';

interface InputMethodSelectorProps {
  selectedMethod: InputMethod | null;
  onSelectMethod: (method: InputMethod) => void;
}

export const InputMethodSelector: React.FC<InputMethodSelectorProps> = ({
  selectedMethod,
  onSelectMethod,
}) => {
  return (
    <div className="flex flex-col gap-2 w-full">
      <span className="text-xs font-semibold text-gray-800 tracking-tight">
        How would you like to add your contract?
      </span>
      <div className="grid grid-cols-1 gap-2 w-full" role="radiogroup" aria-label="Contract input method">
        {/* Option A: Paste contract */}
        <button
          type="button"
          role="radio"
          aria-checked={selectedMethod === 'paste'}
          onClick={() => onSelectMethod('paste')}
          className={`flex items-start gap-3 p-3 rounded-md border text-left transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-200 ${
            selectedMethod === 'paste'
              ? 'border-blue-400 bg-blue-50/30 ring-1 ring-blue-200'
              : 'border-[#E5E7EB] bg-[#FAFAFA] hover:bg-white hover:border-gray-300'
          }`}
        >
          <div
            className={`mt-0.5 p-1.5 rounded-md ${
              selectedMethod === 'paste'
                ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            <Clipboard className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-gray-900">
              Paste contract
            </span>
            <span className="text-[11px] text-gray-500 leading-tight mt-0.5">
              Copy and paste your contract text.
            </span>
          </div>
        </button>

        {/* Option B: Upload file */}
        <button
          type="button"
          role="radio"
          aria-checked={selectedMethod === 'upload'}
          onClick={() => onSelectMethod('upload')}
          className={`flex items-start gap-3 p-3 rounded-md border text-left transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-200 ${
            selectedMethod === 'upload'
              ? 'border-blue-400 bg-blue-50/30 ring-1 ring-blue-200'
              : 'border-[#E5E7EB] bg-[#FAFAFA] hover:bg-white hover:border-gray-300'
          }`}
        >
          <div
            className={`mt-0.5 p-1.5 rounded-md ${
              selectedMethod === 'upload'
                ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            <UploadCloud className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-gray-900">
              Upload file
            </span>
            <span className="text-[11px] text-gray-500 leading-tight mt-0.5">
              Select a contract from your device.
            </span>
          </div>
        </button>
      </div>
    </div>
  );
};
