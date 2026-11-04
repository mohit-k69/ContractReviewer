import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { restoreApiPath } from './vercelEntry';

test.describe('Vercel serverless entry', () => {
  test('restoreApiPath rebuilds the original API path from the routed URL', () => {
    assert.equal(restoreApiPath('/api?__p=contracts/abc123/risk-report'), '/api/contracts/abc123/risk-report');
    assert.equal(restoreApiPath('/api?__p=auth/session'), '/api/auth/session');
    assert.equal(restoreApiPath('/api?__p=contracts/upload&analyze=1'), '/api/contracts/upload?analyze=1');
    assert.equal(restoreApiPath('/api?__p=health'), '/api/health');
    // Platform preserved the original URL and merely appended the helper parameter
    assert.equal(restoreApiPath('/api/contracts/upload?analyze=1&__p=contracts/upload'), '/api/contracts/upload?analyze=1');
    // Untouched when there is nothing to restore
    assert.equal(restoreApiPath('/api/health'), '/api/health');
    assert.equal(restoreApiPath(undefined), '/');
  });

  test('deployment config routes /api/* to a function instead of leaving it to 404', () => {
    const script = fs.readFileSync(path.resolve(process.cwd(), 'scripts/build-vercel.mjs'), 'utf8');
    assert.match(script, /src: '\/api\/\(\.\*\)', dest: '\/api\?__p=\$1'/);
    assert.match(script, /functions['"]?,\s*['"]api\.func/);
    const vercel = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));
    assert.equal(vercel.buildCommand, 'npm run build:vercel');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['build:vercel'], 'node scripts/build-vercel.mjs');
    // The extraction worker threads load these by name at runtime, so the build must ship them with the function.
    for (const name of ['pdf-parse', 'adm-zip', 'fast-xml-parser']) assert.ok(script.includes(`'${name}'`), name);
  });
});
