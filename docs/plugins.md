# Custom provider plugins

QLB discovers every `.js` file in `~/.qlb/plugins/` (or the directory selected by `QLB_PLUGINS_DIR` / `pluginsDir`). A plugin exports one object matching QLB's `Adapter` interface:

```ts
interface Adapter {
  id: string;
  displayName: string;
  fetchSnapshots(): Promise<AccountSnapshot[]>;
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

The returned `accounts` list will include `provider: "mistral"`. Syntax errors, missing exports, and invalid adapter shapes produce a warning on stderr and are skipped.

## Bucket fields

A bucket requires:

- `usedPct`: percentage consumed, or `null` when unknown
- `source`: `poll`, `headers`, or `error`
- `confidence`: `authoritative`, `advisory`, `stale`, or `unknown`
- `fetchedAt`: Unix epoch milliseconds

Optional fields include `used`, `limit`, `remaining`, `resetAt`, `windowMin`, and `detail`. Do not return secrets in labels, errors, details, or other snapshot fields because status output may be logged.
