import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_TYPES,
  DEFAULT_CONTRACT_TYPE_ID,
  getContractTypeById,
  isValidContractType,
} from './contractTypes';

test('CONTRACT_TYPES includes freelance contractor agreement as default', () => {
  assert.equal(CONTRACT_TYPES.length >= 1, true);
  const defaultType = getContractTypeById(DEFAULT_CONTRACT_TYPE_ID);
  assert.ok(defaultType);
  assert.equal(
    defaultType.label,
    'Freelance / Independent Contractor Agreement'
  );
});

test('isValidContractType validates recognized contract type ids', () => {
  assert.equal(isValidContractType('freelance-contractor'), true);
  assert.equal(isValidContractType('non-existent-type'), false);
});
