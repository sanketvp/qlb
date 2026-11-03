#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runCacheOnlyExport } from './export';

/**
 * Keep the cache-only entry point isolated from the main application graph.
 * Loading ./app imports adapters and credential integrations, which this command
 * must never load.
 */
function main(): void {
  if (process.argv[2] === 'export') {
    process.exitCode = runCacheOnlyExport(process.argv.slice(3));
    return;
  }
  const child = spawnSync(process.execPath, [join(__dirname, 'app.js'), ...process.argv.slice(2)], {
    env: process.env,
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`qlb: ${message}`);
    process.exitCode = 2;
  }
}
