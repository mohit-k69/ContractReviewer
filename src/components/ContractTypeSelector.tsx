import React from 'react';
import { ChevronDown } from 'lucide-react';
import { CONTRACT_TYPES, ContractType } from '../utils/contractTypes';

interface ContractTypeSelectorProps {
  value: string;
  onChange: (value: string) => void;
  options?: ContractType[];
}

export const ContractTypeSelector: React.FC<ContractTypeSelectorProps> = ({
  value,
  onChange,
  options = CONTRACT_TYPES,
}) => {
  return (
    <div className="flex flex-col gap-3.5 w-full">
      <label
        htmlFor="contract-type-select"
        className="text-balance text-center text-[19px] font-semibold leading-snug text-gray-900 tracking-tight"
      >
        Type of contract
      </label>
      <div className="relative w-full">
        <select
          id="contract-type-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full appearance-none rounded-xl border border-gray-200 bg-white pl-9 pr-9 text-center text-[12px] text-gray-800 [text-align-last:center] transition-colors hover:border-gray-300 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 cursor-pointer"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3.5 text-gray-400">
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
};
