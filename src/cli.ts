#!/usr/bin/env node
function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`qlb: ${message}`);
  process.exitCode = 2;
}

function main(): void {
  if (process.argv[2] === 'export') {
    const { runCacheOnlyExport } = require('./export') as typeof import('./export');
    process.exitCode = runCacheOnlyExport(process.argv.slice(3));
    return;
  }
  const { main: runApp } = require('./app') as typeof import('./app');
  void runApp().catch(reportError);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    reportError(err);
  }
}
