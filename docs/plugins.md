# Custom provider plugins

QLB discovers every `.js` file in `~/.qlb/plugins/` (or the directory selected by `QLB_PLUGINS_DIR` / `pluginsDir`). A plugin exports one object matching QLB's `Adapter` interface:

```ts
interface Adapter {
  id: string;
  displayName: string;
  fetchSnapshots(): Promise<AccountSnapshot[]>;
  probes?: boolean;            // absent = true; false = this provider has no probe (see below)
  persistsSnapshots?: boolean; // absent = true; false = QLB cannot persist your snapshots (see below)
}

interface AccountSnapshot {
  accountId: string;
  provider: string;
  label: string;
  buckets: Record<string, BucketReading>;
  error?: string;
}
```

`fetchSnapshots()` must be read-only and should return error snapshots rather than throw. QLB also wraps plugin calls so an accidental throw cannot crash `qlb status`. Plugin readings are retained for display and cross-checking and are marked `plugin`; see the [routing-admission rule](ARCHITECTURE.md#confidence-levels).

## Minimal Mistral example

Create `~/.qlb/plugins/mistral.js`:

```js
module.exports = {
  id: 'mistral',
  displayName: 'Mistral',

  async fetchSnapshots() {
    const fetchedAt = Date.now();

    // Replace this example value with a read-only request to the provider.
    const usedPct = 25;

    return [{
      accountId: 'mistral-default',
      provider: 'mistral',
      label: 'Mistral account',
      buckets: {
        monthly: {
          usedPct,
          source: 'plugin',
          confidence: 'advisory',
          fetchedAt
        }
      }
    }];
  }
};
```

In CommonJS, assigning the adapter object to `module.exports` is the module's default export. QLB also accepts transpiled modules shaped as `{ default: adapter }`.

Run:

```bash
qlb status --json
```

## Optional adapter flags

Both fields are optional in `Adapter` (`src/types.ts`); absent means `true`.

- **`probes?: boolean`** — set to `false` when your adapter has no probe at all (nothing `fetchSnapshots()` can usefully fetch on demand). `qlb refresh --allow-probe` then reports the provider as `no-probe` instead of trying to call it. The unscoped built-in Codex adapter is an example: it reads local auth state, while its authorized usage probe is available only through `qlb refresh --provider openai-codex --allow-probe`. Without the flag, refresh calls `fetchSnapshots()`; return snapshots without buckets and it reports `no-data` rather than `no-probe`.
- **`persistsSnapshots?: boolean`** — set to `false` when your plugin cannot persist observations. `qlb why` reproduces a pick from the last persisted per-provider observation; without persisted snapshots it cannot, so the provider is excluded from the parity guarantee and labelled `observation: unavailable`.

The returned `accounts` list will include `provider: "mistral"`. Syntax errors, missing exports, and invalid adapter shapes produce a warning on stderr and are skipped.

QLB normalizes plugin readings to `source: "plugin"` and caps `authoritative` confidence at `advisory`; plugin-provided `stale` and `unknown` confidence remains unchanged.

## Bucket fields

A bucket requires:

- `usedPct`: percentage consumed, or `null` when unknown
- `source`: `provider-poll`, `provider-headers`, `poll`, `headers`, `plugin`, `external-cache`, or `error`
- `confidence`: `authoritative`, `advisory`, `stale`, or `unknown`
- `fetchedAt`: Unix epoch milliseconds

Optional fields include `used`, `limit`, `remaining`, `resetAt`, `windowMin`, and `detail`. Do not return secrets in labels, errors, details, or other snapshot fields because status output may be logged.

## `qlb-pi` (Pi extension)

`qlb-pi` is the Pi extension in `extensions/qlb-pi`. It is not discovered from `~/.qlb/plugins/` and it does not implement `Adapter`. The custom provider plugins above are a separate mechanism.

Deploy it from a release rather than copying the TypeScript by hand:

```bash
node dist/cli.js release install
qlb pi deploy
```

`qlb release install` points `~/.qlb/app/current` at that build. `qlb pi deploy` copies `extensions/qlb-pi` from the current release to `~/.pi/agent/extensions/qlb-pi`, and copies `src/redact.ts` and `src/pi-owner-document.ts` beside the resolved extensions directory. Those are the bytes `pi:extension` and `pi:extension-drift` compare. Flags, hashes, and exit codes are in the [CLI reference](CLI.md#qlb-pi-deploy).

On each request the extension runs `qlb gate <provider> --json` with `QLB_PI_TOKEN_CALL=1`. An unauthorized parent, including a plain shell that sets that variable, exits `3` with stderr `token-call-refused` and empty stdout. `extensions/qlb-pi/active-access.ts` allowlists that cause code, so Pi shows `QLB unavailable for <provider> — run qlb doctor (token-call-refused)` instead of the parent command line.

`decidePiMode` in `extensions/qlb-pi/consume.ts` picks Anthropic's registration. `pi-pool` at `QLB_OWNED` with `cswap-anthropic` at `NATIVE` is `owned`: Pi uses the QLB gate. Dual ownership is `conflict`. That is a valid owner file, or `QLB_PI_REHEARSAL=1`, together with journal `CONSUMED` or a journal Pi could not read. A malformed owner file is `conflict` as well. Conflict registers an error-only Anthropic stub and does not fall back to `anthropic-pool`. The steady state and the `DUAL_OWNERSHIP_REFUSED` CLI refusal are described in [CLAUDE-SWITCHING.md](CLAUDE-SWITCHING.md).

The parent check is `tokenCallAllowed` in `src/commands/token.ts` (interactive Pi's `process.title` of `pi`, with the executable still Node) and `piRpcCallAllowed` in `src/pi-rpc-guard.ts` (`process.title` of `pi-rpc` only when the kernel comm, the Node text executable, Pi's environment, and an RPC entry under the located Pi package agree). `qlb token` uses the same guard for `xai`, `kimi-coding`, and `openrouter`. A refused `qlb token` exits `3` with empty stdout and empty stderr; only `qlb gate` prints `token-call-refused`.
