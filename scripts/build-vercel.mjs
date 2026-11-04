// Builds the Vercel deployment using the Build Output API (https://vercel.com/docs/build-output-api/v3):
//   .vercel/output/static            <- the Vite frontend (dist/)
//   .vercel/output/functions/api.func <- the Express backend, bundled into one file
//   .vercel/output/config.json       <- routes /api/* to the function
// Without this, Vercel only serves the static frontend and every /api/* request returns 404.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const out = path.join(root, '.vercel', 'output');
const funcDir = path.join(out, 'functions', 'api.func');

console.log('[build-vercel] building frontend (vite build)');
execSync('npx vite build', { stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(funcDir, { recursive: true });

// 1. Static frontend
fs.cpSync(path.join(root, 'dist'), path.join(out, 'static'), { recursive: true });

// 2. Backend function: one self-contained ESM file.
//    The banner gives bundled CommonJS dependencies (express, multer, ...) a working `require`.
console.log('[build-vercel] bundling backend');
await build({
  entryPoints: [path.join(root, 'src/server/vercelEntry.ts')],
  outfile: path.join(funcDir, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);",
  },
});

// 2b. Packages that the PDF/DOCX extraction worker threads load by name at runtime
//     (`new Worker(code, { eval: true })` + require('pdf-parse')). A bundler cannot see those requires, so ship
//     the packages and their dependency closure next to the bundle (the function's working directory).
const RUNTIME_PACKAGES = ['pdf-parse', 'adm-zip', 'fast-xml-parser'];
const nodeModules = path.join(root, 'node_modules');
const copied = new Set();
function copyWithDependencies(name) {
  if (copied.has(name)) return;
  const src = path.join(nodeModules, name);
  if (!fs.existsSync(src)) return; // optional dependency not installed for this platform
  copied.add(name);
  fs.cpSync(src, path.join(funcDir, 'node_modules', name), { recursive: true, dereference: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    copyWithDependencies(dep);
  }
}
RUNTIME_PACKAGES.forEach(copyWithDependencies);
console.log(`[build-vercel] bundled runtime packages for extraction workers: ${[...copied].join(', ')}`);

fs.writeFileSync(
  path.join(funcDir, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      // Raw Node req/res: multer and express parse the request themselves.
      shouldAddHelpers: false,
      maxDuration: 60,
      memory: 1024,
    },
    null,
    2
  )
);
// The function's package.json marks the bundle as ESM
fs.writeFileSync(path.join(funcDir, 'package.json'), JSON.stringify({ type: 'module' }));

// 3. Routing: /api/* -> function; everything else is static (SPA fallback to index.html)
fs.writeFileSync(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '/api/(.*)', dest: '/api?__p=$1' },
        { src: '/api', dest: '/api?__p=' },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: '/index.html' },
      ],
    },
    null,
    2
  )
);

const size = (fs.statSync(path.join(funcDir, 'index.mjs')).size / 1024 / 1024).toFixed(2);
console.log(`[build-vercel] done: function bundle ${size} MB -> ${path.relative(root, out)}`);
