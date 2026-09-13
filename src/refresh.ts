import type { AccountSnapshot, Adapter } from './types';

export type RefreshStatus = 'ok' | 'partial' | 'no-data' | 'no-probe' | 'error';

export interface RefreshAccountError {
  accountId: string;
  error: string;
}

export interface RefreshResult {
  provider: string;
  displayName: string;
  ok: boolean;
  status: RefreshStatus;
  accounts: number;
  accountsOk: number;
  accountsFailed: number;
  error?: string;
  errors: RefreshAccountError[];
  snapshots: AccountSnapshot[];
}

export interface RefreshReport {
  probed: boolean;
  results: RefreshResult[];
}

export interface RefreshIo {
  log: (line: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function accountError(snapshot: AccountSnapshot): string | undefined {
  if (snapshot.error) return snapshot.error;
  if (snapshot.probe?.outcome === 'cached-after-failure') {
    const detail = snapshot.probe.detail ?? 'unknown error';
    return `probe failed: ${detail}; cached reading retained`;
  }
  return undefined;
}

function classifyAccount(snapshot: AccountSnapshot): 'ok' | 'failed' | 'no-data' {
  if (snapshot.error) return 'failed';
  if (snapshot.probe?.outcome === 'cached-after-failure') return 'failed';
  if (Object.keys(snapshot.buckets).length > 0) return 'ok';
  return 'no-data';
}

function emptyResult(adapter: Adapter, error: string): RefreshResult {
  return {
    provider: adapter.id,
    displayName: adapter.displayName,
    ok: false,
    status: 'error',
    accounts: 0,
    accountsOk: 0,
    accountsFailed: 0,
    error,
    errors: [],
    snapshots: [],
  };
}

function classify(adapter: Adapter, snapshots: AccountSnapshot[]): RefreshResult {
  const errors: RefreshAccountError[] = [];
  let accountsOk = 0;
  let accountsFailed = 0;
  for (const snapshot of snapshots) {
    const kind = classifyAccount(snapshot);
    if (kind === 'ok') accountsOk += 1;
    else if (kind === 'failed') {
      accountsFailed += 1;
      const error = accountError(snapshot) ?? 'probe failed';
      errors.push({ accountId: snapshot.accountId, error });
    }
  }

  const base = {
    provider: adapter.id,
    displayName: adapter.displayName,
    accounts: snapshots.length,
    accountsOk,
    accountsFailed,
    errors,
    snapshots,
  };

  if (snapshots.length === 0) {
    return { ...base, ok: false, status: 'error', error: 'no snapshots returned' };
  }

  const joined = errors.map((e) => e.error).join('; ') || undefined;

  if (adapter.probes === false) {
    if (snapshots.some((snapshot) => snapshot.error)) {
      return { ...base, ok: false, status: 'error', error: joined ?? 'probe failed' };
    }
    return { ...base, ok: false, status: 'no-probe' };
  }

  if (accountsOk > 0 && accountsFailed > 0) {
    return { ...base, ok: false, status: 'partial', error: joined };
  }
  if (accountsOk > 0) {
    return { ...base, ok: true, status: 'ok', ...(joined ? { error: joined } : {}) };
  }
  if (accountsFailed > 0) {
    return { ...base, ok: false, status: 'error', error: joined ?? 'probe failed' };
  }
  return { ...base, ok: false, status: 'no-data' };
}

async function probeOne(adapter: Adapter): Promise<RefreshResult> {
  try {
    const snapshots = await adapter.fetchSnapshots();
    return classify(adapter, snapshots);
  } catch (err) {
    return emptyResult(adapter, errorMessage(err));
  }
}

export async function runRefresh(
  adapters: readonly Adapter[],
  opts: { allowProbe: boolean },
): Promise<RefreshReport> {
  if (!opts.allowProbe) {
    return { probed: false, results: [] };
  }

  const settled = await Promise.allSettled(adapters.map((adapter) => probeOne(adapter)));
  const results = settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    return emptyResult(adapters[index], errorMessage(outcome.reason));
  });
  return { probed: true, results };
}

function glyph(status: RefreshStatus): string {
  if (status === 'ok') return '[OK]  ';
  if (status === 'partial') return '[PART]';
  if (status === 'no-data' || status === 'no-probe') return '[NONE]';
  return '[FAIL]';
}

export function formatRefresh(report: RefreshReport): string {
  if (!report.probed) {
    return 'refresh: no probes run (pass --allow-probe to poll providers)';
  }

  let ok = 0;
  let partial = 0;
  let none = 0;
  let noProbe = 0;
  let failed = 0;
  const lines: string[] = [];
  for (const result of report.results) {
    const head = `${glyph(result.status)} ${result.provider} (${result.displayName})`;
    if (result.status === 'ok') {
      ok += 1;
      lines.push(`${head}: ${result.accounts} account(s)`);
    } else if (result.status === 'partial') {
      partial += 1;
      lines.push(`${head}: ${result.accountsOk} ok, ${result.accountsFailed} failed`);
      for (const err of result.errors) {
        lines.push(`  ${err.accountId}: ${err.error}`);
      }
    } else if (result.status === 'no-probe') {
      noProbe += 1;
      lines.push(
        `${head}: no probe available — readings come from proxy traffic (${result.accounts} account(s) from credentials)`,
      );
    } else if (result.status === 'no-data') {
      none += 1;
      lines.push(
        `${head}: authenticated, no gauge — provider has no probe (readings come from proxy traffic)`,
      );
    } else {
      failed += 1;
      lines.push(`${head}: ${result.error ?? 'probe failed'}`);
    }
  }
  lines.push(
    `Probed ${report.results.length} provider(s): ${ok} ok, ${partial} partial, ${none} no-data, ${noProbe} no-probe, ${failed} failed`,
  );
  return lines.join('\n');
}

export async function refreshCommand(
  adapters: readonly Adapter[],
  opts: { allowProbe: boolean; json: boolean },
  io: RefreshIo = { log: console.log },
): Promise<number> {
  const report = await runRefresh(adapters, { allowProbe: opts.allowProbe });
  io.log(opts.json ? JSON.stringify(report, null, 2) : formatRefresh(report));
  return 0;
}
