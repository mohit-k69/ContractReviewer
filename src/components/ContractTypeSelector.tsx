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
    <div className="flex flex-col gap-1.5 w-full">
      <label
        htmlFor="contract-type-select"
        className="text-xs font-semibold text-gray-800 tracking-tight"
      >
        Type of contract
      </label>
      <div className="relative w-full">
        <select
          id="contract-type-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none rounded-[13px] border border-[#E5E7EB] bg-[#FAFAFA] pl-3 pr-8 py-2.5 text-[13px] text-gray-900 transition-colors focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 cursor-pointer"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400">
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
};
