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
      <div
        className="grid grid-cols-2 gap-2 w-full"
        role="radiogroup"
        aria-label="Contract input method"
      >
        {/* Option A: Paste contract */}
        <button
          type="button"
          role="radio"
          aria-checked={selectedMethod === 'paste'}
          onClick={() => onSelectMethod('paste')}
          className={`flex items-center justify-center gap-2 h-11 px-3 rounded-full border text-xs transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-200 ${
            selectedMethod === 'paste'
              ? 'border-blue-400 bg-blue-50/70 text-blue-700 font-semibold ring-1 ring-blue-200'
              : 'border-[#E5E7EB] bg-[#FAFAFA] text-gray-700 font-medium hover:bg-white hover:border-gray-300 hover:text-gray-900'
          }`}
        >
          <Clipboard className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Paste contract</span>
        </button>

        {/* Option B: Upload file */}
        <button
          type="button"
          role="radio"
          aria-checked={selectedMethod === 'upload'}
          onClick={() => onSelectMethod('upload')}
          className={`flex items-center justify-center gap-2 h-11 px-3 rounded-full border text-xs transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-200 ${
            selectedMethod === 'upload'
              ? 'border-blue-400 bg-blue-50/70 text-blue-700 font-semibold ring-1 ring-blue-200'
              : 'border-[#E5E7EB] bg-[#FAFAFA] text-gray-700 font-medium hover:bg-white hover:border-gray-300 hover:text-gray-900'
          }`}
        >
          <UploadCloud className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Upload file</span>
        </button>
      </div>
    </div>
  );
};
