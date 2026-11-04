import React from 'react';

interface ContractInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export const ContractInput: React.FC<ContractInputProps> = ({
  value,
  onChange,
  placeholder = 'Paste your contract here...',
}) => {
  return (
    <div className="w-full flex-1 flex flex-col">
      <label htmlFor="contract-text-input" className="sr-only">
        Contract Text
      </label>
      <textarea
        id="contract-text-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full flex-1 min-h-[520px] rounded-[14px] border border-[#E5E7EB] bg-[#FAFAFA] p-3.5 text-sm text-gray-900 placeholder:text-gray-400 transition-colors focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 resize-y overflow-y-auto leading-relaxed"
      />
    </div>
  );
};
