import type { AccountSnapshot, Adapter } from './types';

export type RefreshStatus = 'ok' | 'no-data' | 'error';

export interface RefreshResult {
  provider: string;
  displayName: string;
  ok: boolean;
  status: RefreshStatus;
  accounts: number;
  error?: string;
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

function joinedSnapshotErrors(snapshots: AccountSnapshot[]): string | undefined {
  const parts = snapshots
    .map((snapshot) => snapshot.error)
    .filter((message): message is string => typeof message === 'string' && message.length > 0);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function classify(adapter: Adapter, snapshots: AccountSnapshot[]): RefreshResult {
  const base = {
    provider: adapter.id,
    displayName: adapter.displayName,
    accounts: snapshots.length,
    snapshots,
  };
  if (snapshots.length === 0) {
    return { ...base, ok: false, status: 'error', error: 'no snapshots returned' };
  }

  const joinedErrors = joinedSnapshotErrors(snapshots);
  const hasCleanWithBuckets = snapshots.some(
    (snapshot) => !snapshot.error && Object.keys(snapshot.buckets).length > 0,
  );
  if (hasCleanWithBuckets) {
    return {
      ...base,
      ok: true,
      status: 'ok',
      ...(joinedErrors ? { error: joinedErrors } : {}),
    };
  }

  const hasClean = snapshots.some((snapshot) => !snapshot.error);
  const noneHaveBuckets = snapshots.every((snapshot) => Object.keys(snapshot.buckets).length === 0);
  if (hasClean && noneHaveBuckets) {
    return { ...base, ok: false, status: 'no-data' };
  }

  return {
    ...base,
    ok: false,
    status: 'error',
    error: joinedErrors ?? 'probe failed',
  };
}

async function probeOne(adapter: Adapter): Promise<RefreshResult> {
  try {
    const snapshots = await adapter.fetchSnapshots();
    return classify(adapter, snapshots);
  } catch (err) {
    return {
      provider: adapter.id,
      displayName: adapter.displayName,
      ok: false,
      status: 'error',
      accounts: 0,
      error: errorMessage(err),
      snapshots: [],
    };
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
    const adapter = adapters[index];
    return {
      provider: adapter.id,
      displayName: adapter.displayName,
      ok: false,
      status: 'error' as const,
      accounts: 0,
      error: errorMessage(outcome.reason),
      snapshots: [],
    };
  });
  return { probed: true, results };
}

function glyph(status: RefreshStatus): string {
  if (status === 'ok') return '[OK]  ';
  if (status === 'no-data') return '[NONE]';
  return '[FAIL]';
}

export function formatRefresh(report: RefreshReport): string {
  if (!report.probed) {
    return 'refresh: no probes run (pass --allow-probe to poll providers)';
  }

  let ok = 0;
  let none = 0;
  let failed = 0;
  const lines: string[] = [];
  for (const result of report.results) {
    const head = `${glyph(result.status)} ${result.provider} (${result.displayName})`;
    if (result.status === 'ok') {
      ok += 1;
      lines.push(`${head}: ${result.accounts} account(s)`);
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
    `Probed ${report.results.length} provider(s): ${ok} ok, ${none} no-data, ${failed} failed`,
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
