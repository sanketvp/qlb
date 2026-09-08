#!/usr/bin/env node
import { adapters } from './adapters';
import type { AccountSnapshot, Adapter } from './types';

const USAGE = 'Usage: qlb [status] [--json]';

function parseArgs(argv: string[]): { json: boolean } {
  const args = argv.slice(2);
  let json = false;
  for (const arg of args) {
    if (arg === 'status') continue;
    if (arg === '--json') {
      json = true;
      continue;
    }
    console.error(USAGE);
    process.exit(1);
  }
  return { json };
}

async function safeFetch(adapter: Adapter): Promise<AccountSnapshot[]> {
  try {
    return await adapter.fetchSnapshots();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        accountId: adapter.id,
        provider: adapter.id,
        label: adapter.displayName,
        buckets: {},
        error: message,
      },
    ];
  }
}

function formatRelative(resetAt?: number): string {
  if (resetAt == null || !Number.isFinite(resetAt)) return '-';
  const deltaMs = resetAt - Date.now();
  const absMs = Math.abs(deltaMs);
  const totalMins = Math.round(absMs / 60_000);
  let rel: string;
  if (totalMins < 1) {
    rel = '<1m';
  } else if (totalMins < 60) {
    rel = `${totalMins}m`;
  } else {
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    rel = mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
  }
  return deltaMs >= 0 ? `in ${rel}` : `${rel} ago`;
}

function formatUsedPct(usedPct: number | null): string {
  return usedPct == null ? '—' : `${usedPct}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

interface Row {
  provider: string;
  label: string;
  bucket: string;
  usedPct: string;
  confidence: string;
  reset: string;
}

function toRows(accounts: AccountSnapshot[]): Row[] {
  const rows: Row[] = [];
  for (const snap of accounts) {
    const entries = Object.entries(snap.buckets);
    if (entries.length === 0 && snap.error) {
      rows.push({
        provider: snap.provider,
        label: snap.label,
        bucket: '-',
        usedPct: '-',
        confidence: 'error',
        reset: snap.error,
      });
      continue;
    }
    for (const [bucket, reading] of entries) {
      rows.push({
        provider: snap.provider,
        label: snap.label,
        bucket,
        usedPct: formatUsedPct(reading.usedPct),
        confidence: reading.confidence,
        reset: formatRelative(reading.resetAt),
      });
    }
  }
  return rows;
}

function printTable(accounts: AccountSnapshot[]): void {
  const rows = toRows(accounts);
  const widths = {
    provider: 'provider'.length,
    label: 'account'.length,
    bucket: 'bucket'.length,
    usedPct: 'used'.length,
    confidence: 'confidence'.length,
    reset: 'resets'.length,
  };
  for (const row of rows) {
    widths.provider = Math.max(widths.provider, row.provider.length);
    widths.label = Math.max(widths.label, row.label.length);
    widths.bucket = Math.max(widths.bucket, row.bucket.length);
    widths.usedPct = Math.max(widths.usedPct, row.usedPct.length);
    widths.confidence = Math.max(widths.confidence, row.confidence.length);
    widths.reset = Math.max(widths.reset, `resets ${row.reset}`.length);
  }

  const line = (
    provider: string,
    label: string,
    bucket: string,
    usedPct: string,
    confidence: string,
    reset: string,
  ): string =>
    [
      pad(provider, widths.provider),
      pad(label, widths.label),
      pad(bucket, widths.bucket),
      pad(usedPct, widths.usedPct),
      pad(confidence, widths.confidence),
      pad(reset, widths.reset),
    ].join(' | ');

  console.log(line('provider', 'account', 'bucket', 'used', 'confidence', 'resets'));
  for (const row of rows) {
    console.log(
      line(row.provider, row.label, row.bucket, row.usedPct, row.confidence, `resets ${row.reset}`),
    );
  }
}

async function main(): Promise<void> {
  const { json } = parseArgs(process.argv);
  const nested = await Promise.all(adapters.map((adapter) => safeFetch(adapter)));
  const accounts = nested.flat();
  if (json) {
    console.log(JSON.stringify({ fetchedAt: Date.now(), accounts }, null, 2));
  } else {
    printTable(accounts);
  }
  process.exit(0);
}

void main();
