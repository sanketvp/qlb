import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AccountSnapshot, Adapter } from './types';

export type PluginWarning = (message: string) => void;

function isAdapter(value: unknown): value is Adapter {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Adapter>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.displayName === 'string' &&
    candidate.displayName.length > 0 &&
    typeof candidate.fetchSnapshots === 'function'
  );
}

function safePluginAdapter(adapter: Adapter, fileName: string, warn: PluginWarning): Adapter {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    async fetchSnapshots(): Promise<AccountSnapshot[]> {
      try {
        const snapshots = await adapter.fetchSnapshots();
        if (!Array.isArray(snapshots)) {
          throw new Error('fetchSnapshots() did not return an array');
        }
        return snapshots;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        warn(`qlb: plugin ${fileName} failed: ${reason}`);
        return [{
          accountId: adapter.id,
          provider: adapter.id,
          label: adapter.displayName,
          buckets: {},
          error: reason,
        }];
      }
    },
  };
}

/** Load CommonJS-compatible .js adapters from the configured plugin directory. */
export function loadPlugins(
  pluginsDir: string,
  warn: PluginWarning = (message) => console.error(message),
): Adapter[] {
  if (!existsSync(pluginsDir)) return [];

  const plugins: Adapter[] = [];
  let files: string[];
  try {
    files = readdirSync(pluginsDir).filter((file) => file.endsWith('.js')).sort();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`qlb: cannot read plugin directory ${pluginsDir}: ${reason}`);
    return [];
  }

  for (const file of files) {
    const fullPath = resolve(pluginsDir, file);
    try {
      // eslint-free CommonJS loading is intentional: QLB itself compiles to CJS,
      // and accepting module.exports plus transpiled `default` keeps plugins tiny.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require(fullPath) as unknown;
      const exported = loaded && typeof loaded === 'object' && 'default' in loaded
        ? (loaded as { default: unknown }).default
        : loaded;
      if (!isAdapter(exported)) {
        throw new Error('default export must provide id, displayName, and fetchSnapshots()');
      }
      plugins.push(safePluginAdapter(exported, file, warn));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`qlb: skipping plugin ${file}: ${reason}`);
    }
  }
  return plugins;
}
