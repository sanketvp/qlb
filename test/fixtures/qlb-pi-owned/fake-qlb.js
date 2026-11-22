// Stand-in for `qlb` on PATH for test/qlb-pi-owned-providers.test.ts. Records
// every call. Answers the Pi credential call with a sentinel token, or refuses
// when OWNED_REFUSE=1. Every other subcommand exits 3 so it stays visible.
const fs = require('node:fs');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.OWNED_CALLS, JSON.stringify(args) + '\n');
if (args[0] === 'gate' && args.length === 3 && args[2] === '--json') {
  if (process.env.OWNED_REFUSE === '1') {
    process.stderr.write('credential-unavailable\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    token: `GATE-SENTINEL-${args[1]}`,
    accountId: 'default',
    source: 'keychain',
    expiresAt: Date.now() + 3_600_000,
  }));
  process.exit(0);
}
process.exit(3);
