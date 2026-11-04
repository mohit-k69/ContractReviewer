export interface ContractType {
  id: string;
  label: string;
}

export const CONTRACT_TYPES: ContractType[] = [
  {
    id: 'freelance-contractor',
    label: 'Freelance / Independent Contractor Agreement',
  },
];

export const DEFAULT_CONTRACT_TYPE_ID = 'freelance-contractor';

export function getContractTypeById(id: string): ContractType | undefined {
  return CONTRACT_TYPES.find((type) => type.id === id);
}

export function isValidContractType(id: string): boolean {
  return CONTRACT_TYPES.some((type) => type.id === id);
}
