import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describeStartupEnvironment } from './runtimeDiagnostics';

const SECRET = 'unit-test-secret-value-9f3c1a7e';

/** Starts the real Vercel handler in a fresh process (the secret is read once, at import) under the given environment. */
function probe(env: Record<string, string>): { status: number; body: any; output: string } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(process.cwd(), 'src/server/vercelStartupProbe.ts')], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE '));
  assert.ok(line, `probe produced no result:\n${output}`);
  return { ...JSON.parse(line.slice(6)), output };
}

test.describe('Vercel startup and SESSION_SECRET', () => {
  test('production on a Preview deployment starts when SESSION_SECRET is set, and never logs the value', () => {
    const r = probe({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview', SESSION_SECRET: SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.sessionSecretConfigured, true);
    assert.match(r.output, /startup environment:.*"sessionSecret":"present".*"vercelEnv":"preview"/);
    assert.ok(!r.output.includes(SECRET), 'the secret must never be logged');
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
  });

  test('production without SESSION_SECRET fails closed with a clear, safe 503', () => {
    const r = probe({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'Backend failed to start.');
    assert.match(r.body.detail, /SESSION_SECRET/);
    assert.deepEqual(r.body.diagnostics, { sessionSecret: 'missing', nodeEnv: 'production', vercelEnv: 'preview', onVercel: true, similarlyNamedVariable: false });
  });

  test('an empty SESSION_SECRET is rejected and reported as empty', () => {
    const r = probe({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview', SESSION_SECRET: '' });
    assert.equal(r.status, 503);
    assert.equal(r.body.diagnostics.sessionSecret, 'empty');
  });

  test('a mistyped variable name is flagged without revealing any name or value', () => {
    const r = probe({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview', 'SESSION_SECRET ': SECRET });
    assert.equal(r.status, 503);
    assert.equal(r.body.diagnostics.sessionSecret, 'missing');
    assert.equal(r.body.diagnostics.similarlyNamedVariable, true);
    assert.ok(!r.output.includes(SECRET));
  });

  test('outside production there is no hard requirement (local development)', () => {
    const r = probe({ NODE_ENV: 'development' });
    assert.equal(r.status, 200);
  });

  test('diagnostics contain only presence flags', () => {
    const d = describeStartupEnvironment({ SESSION_SECRET: SECRET, NODE_ENV: 'production', VERCEL_ENV: 'preview', OTHER: 'x' } as any);
    assert.ok(!JSON.stringify(d).includes(SECRET));
    assert.deepEqual(Object.keys(d).sort(), ['nodeEnv', 'onVercel', 'sessionSecret', 'similarlyNamedVariable', 'vercelEnv']);
  });
});
