// Stand-in for `qlb` used via QLB_CLI. Answers only `consume status`: prints the
// next state from SMOKE_STATES (comma list, last repeats); `unknown` exits 1.
// Any other subcommand fails so an unexpected call is visible.
const fs = require('node:fs');

const args = process.argv.slice(2);
if (args[0] !== 'consume' || args[1] !== 'status') {
  process.stderr.write(`unexpected qlb call: ${args.join(' ')}\n`);
  process.exit(3);
}
const states = String(process.env.SMOKE_STATES || 'NATIVE').split(',');
const counter = process.env.SMOKE_COUNTER;
let n = 0;
try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch { /* first call */ }
fs.writeFileSync(counter, String(n + 1));
const state = states[Math.min(n, states.length - 1)];
if (state === 'unknown') process.exit(1);
process.stdout.write(JSON.stringify({ provider: 'anthropic', store: 'cswap-anthropic', state }));
