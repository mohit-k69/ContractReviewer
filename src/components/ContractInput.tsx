import React from 'react';
import { FileSearch } from 'lucide-react';
import { MAX_FILE_SIZE_BYTES } from '../utils/fileValidation';

interface ContractInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Called when the user asks to review the pasted text. The text goes through the same security pipeline as an upload. */
  onSubmit?: (text: string) => void;
}

export const MIN_PASTED_CHARS = 200;

export const ContractInput: React.FC<ContractInputProps> = ({
  value,
  onChange,
  placeholder = 'Paste your contract here...',
  onSubmit,
}) => {
  const trimmed = value.trim();
  const tooShort = trimmed.length < MIN_PASTED_CHARS;
  const tooLarge = new Blob([value]).size > MAX_FILE_SIZE_BYTES;
  const canSubmit = Boolean(onSubmit) && !tooShort && !tooLarge;

  return (
    <div className="w-full flex-1 flex flex-col gap-3">
      <label htmlFor="contract-text-input" className="sr-only">
        Contract Text
      </label>
      <textarea
        id="contract-text-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full flex-1 min-h-[180px] h-[34vh] max-h-[340px] rounded-xl border border-gray-200 bg-white p-3.5 text-sm text-gray-900 placeholder:text-gray-400 transition-colors focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 resize-y overflow-y-auto leading-relaxed"
      />
      {onSubmit && (
        <>
          <button
            type="button"
            onClick={() => onSubmit(value)}
            disabled={!canSubmit}
            className="w-full h-11 rounded-[14px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-300 text-white font-medium text-xs tracking-tight transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm disabled:cursor-not-allowed"
          >
            <FileSearch className="w-4 h-4" aria-hidden="true" />
            <span>Review pasted contract</span>
          </button>
          <span className="text-[11px] text-gray-500" role="status">
            {tooLarge
              ? 'Pasted text is larger than the 20 MB limit.'
              : tooShort
              ? `Paste the full agreement (at least ${MIN_PASTED_CHARS} characters). Pasted text is security-checked like an uploaded file.`
              : `${trimmed.length.toLocaleString()} characters ready. Pasted text is security-checked like an uploaded file.`}
          </span>
        </>
      )}
    </div>
  );
};
