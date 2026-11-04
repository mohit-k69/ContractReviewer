import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignedSessionToken,
  verifySessionToken,
} from './sessionAuth';

test('creates and verifies valid signed session token', () => {
  const token = createSignedSessionToken('user-123');
  const session = verifySessionToken(token);

  assert.ok(session);
  assert.equal(session.sessionId, 'user-123');
  assert.equal(typeof session.issuedAt, 'number');
});

test('rejects missing or empty token', () => {
  assert.equal(verifySessionToken(undefined), null);
  assert.equal(verifySessionToken(''), null);
});

test('rejects malformed token structure', () => {
  assert.equal(verifySessionToken('invalid.token'), null);
  assert.equal(verifySessionToken('just-a-plain-string'), null);
});

test('rejects tampered session identifier or timestamp', () => {
  const token = createSignedSessionToken('legitimate-user');
  const [id, ts, sig] = token.split('.');

  // Tamper with the user ID
  const spoofedToken = `attacker-user.${ts}.${sig}`;
  assert.equal(verifySessionToken(spoofedToken), null);

  // Tamper with timestamp
  const alteredTimeToken = `${id}.${Date.now() + 10000}.${sig}`;
  assert.equal(verifySessionToken(alteredTimeToken), null);
});

test('rejects forged signature', () => {
  const token = createSignedSessionToken('legitimate-user');
  const [id, ts] = token.split('.');
  const forgedToken = `${id}.${ts}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;

  assert.equal(verifySessionToken(forgedToken), null);
});
