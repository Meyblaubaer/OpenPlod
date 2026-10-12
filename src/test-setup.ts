import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test preload. `src/db/client.ts` opens its database once per process, so
 * whichever test file imports it first decides the path for all of them.
 * Default that path to a fresh temporary vault so a test run can never read
 * leftovers from an earlier run, or write into a developer's `./data`.
 */
const root = mkdtempSync(join(tmpdir(), 'openplod-test-'));
process.env.DATABASE_URL ??= join(root, 'vault.db');
process.env.OPENPLOD_LIBRARY_PATH ??= join(root, 'recordings');
