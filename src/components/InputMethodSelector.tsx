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
    <div className="flex flex-col gap-3 w-full">
      <span id="input-method-label" className="text-[15px] font-semibold text-gray-900 tracking-tight">
        How would you like to add your contract?
      </span>
      <div
        className="grid grid-cols-2 gap-3 w-full"
        role="radiogroup"
        aria-labelledby="input-method-label"
      >
        {/* Option A: Paste contract */}
        <button
          type="button"
          role="radio"
          aria-checked={selectedMethod === 'paste'}
          onClick={() => onSelectMethod('paste')}
          className={`flex items-center justify-center gap-2 h-11 px-3 rounded-xl border text-xs transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-300 ${
            selectedMethod === 'paste'
              ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold'
              : 'border-gray-200 bg-white text-gray-700 font-medium hover:border-gray-300 hover:bg-gray-50'
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
          className={`flex items-center justify-center gap-2 h-11 px-3 rounded-xl border text-xs transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-300 ${
            selectedMethod === 'upload'
              ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold'
              : 'border-gray-200 bg-white text-gray-700 font-medium hover:border-gray-300 hover:bg-gray-50'
          }`}
        >
          <UploadCloud className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Upload file</span>
        </button>
      </div>
    </div>
  );
};
