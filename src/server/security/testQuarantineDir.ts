// Test-only. Import this FIRST in a test file that inspects the quarantine directory: it gives the test process its own
// directory, so tests running in parallel in other processes cannot add or remove files while it counts them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QUARANTINE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-test-'));
