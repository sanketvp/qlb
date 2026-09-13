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

`fetchSnapshots()` must be read-only and should return error snapshots rather than throw. QLB also wraps plugin calls so an accidental throw cannot crash `qlb status`.

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
          source: 'poll',
          confidence: 'authoritative',
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

- **`probes?: boolean`** — set to `false` when your adapter has no probe at all (nothing `fetchSnapshots()` can usefully fetch on demand). `qlb refresh --allow-probe` then reports the provider as `no-probe` instead of trying to call it. Codex is the built-in example: it exposes no usage endpoint, so its readings come from proxy header parsing. Without the flag, refresh calls `fetchSnapshots()`; return snapshots without buckets and it reports `no-data` rather than `no-probe`.
- **`persistsSnapshots?: boolean`** — set to `false` when your plugin cannot persist observations. `qlb why` reproduces a pick from the last persisted per-provider observation; without persisted snapshots it cannot, so the provider is excluded from the parity guarantee and labelled `observation: unavailable`.

The returned `accounts` list will include `provider: "mistral"`. Syntax errors, missing exports, and invalid adapter shapes produce a warning on stderr and are skipped.

## Bucket fields

A bucket requires:

- `usedPct`: percentage consumed, or `null` when unknown
- `source`: `poll`, `headers`, or `error`
- `confidence`: `authoritative`, `advisory`, `stale`, or `unknown`
- `fetchedAt`: Unix epoch milliseconds

Optional fields include `used`, `limit`, `remaining`, `resetAt`, `windowMin`, and `detail`. Do not return secrets in labels, errors, details, or other snapshot fields because status output may be logged.
