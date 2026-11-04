import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateContractFile,
  formatFileSize,
  MAX_FILE_SIZE_BYTES,
} from './fileValidation';

test('validates supported file extensions (.pdf, .docx, .txt)', () => {
  assert.equal(validateContractFile({ name: 'agreement.pdf', size: 1024 }).valid, true);
  assert.equal(validateContractFile({ name: 'contract.docx', size: 50000 }).valid, true);
  assert.equal(validateContractFile({ name: 'notes.txt', size: 100 }).valid, true);
});

test('rejects unsupported file extensions', () => {
  const result = validateContractFile({ name: 'document.png', size: 1024 });
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /Unsupported file type/);
});

test('rejects files larger than 20MB', () => {
  const result = validateContractFile({
    name: 'heavy.pdf',
    size: MAX_FILE_SIZE_BYTES + 1,
  });
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /too large/);
});

test('rejects empty 0 byte files', () => {
  const result = validateContractFile({ name: 'empty.pdf', size: 0 });
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /empty/);
});

test('formats file sizes accurately', () => {
  assert.equal(formatFileSize(500), '500 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
  assert.equal(formatFileSize(2 * 1024 * 1024), '2.0 MB');
});
