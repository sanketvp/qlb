/**
 * Pi ↔ QLB integration health, surfaced through `qlb doctor` as `pi:*` checks.
 *
 * Pi (`@earendil-works/pi-coding-agent`, global npm) may upgrade freely. The qlb-pi extension
 * depends on a few Pi seams (ExtensionAPI events, `@earendil-works/pi-ai/compat`
 * `anthropicMessagesApi().streamSimple`). These checks report when a Pi upgrade moved them,
 * and whether the installed extension copy matches the tracked source.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DoctorCheck } from './diagnostics';
import { findQlbRepoRoot } from './setup';

const PI_PKG = '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const PI_EXT_DIR = join(homedir(), '.pi', 'agent', 'extensions', 'qlb-pi');
/** Pi runtime seams the extension calls; missing → the extension throws at load or first stream. */
const PI_SEAMS: Array<{ id: string; dir: string; pattern: RegExp; why: string }> = [
  { id: 'anthropicMessagesApi', dir: 'node_modules/@earendil-works/pi-ai/dist', pattern: /\banthropicMessagesApi\b/, why: 'qlb-pi forwards Anthropic streams through anthropicMessagesApi().streamSimple' },
  { id: 'registerProvider', dir: 'dist', pattern: /\bregisterProvider\b/, why: 'qlb-pi registers itself as the "anthropic" provider' },
  { id: 'model_select', dir: 'dist', pattern: /\bmodel_select\b/, why: 'qlb-pi listens to model_select to run qlb resolve' },
  { id: 'after_provider_response', dir: 'dist', pattern: /\bafter_provider_response\b/, why: 'qlb-pi records the audit outcome from after_provider_response' },
];

/** Recursively list .d.ts files (bounded: Pi's dist is a few hundred files). */
function dtsFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let entries: import('node:fs').Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') dtsFiles(p, out, depth + 1); }
    else if (e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export interface PiIntegrationOptions {
  /** Run `tsc --noEmit` against the installed Pi types (slow, ~3s). doctor --live turns it on. */
  typecheck?: boolean;
  run?: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => string;
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

export function piIntegrationChecks(options: PiIntegrationOptions = {}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const run = options.run ?? ((cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number } = {}) =>
    execFileSync(cmd, args, { encoding: 'utf8', cwd: o.cwd, timeout: o.timeoutMs ?? 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));

  if (!existsSync(PI_PKG) || !existsSync(PI_EXT_DIR)) {
    checks.push({ name: 'pi:extension', level: 'PASS', message: 'Pi or the qlb-pi extension is not installed; skipping Pi checks' });
    return checks;
  }

  const piVersion = (() => { try { return (JSON.parse(readText(join(PI_PKG, 'package.json')) ?? '{}') as { version?: string }).version ?? '?'; } catch { return '?'; } })();

  // 1. Installed extension == tracked source (a QLB upgrade that touches extensions/qlb-pi must be re-synced).
  const repoRoot = findQlbRepoRoot();
  if (repoRoot) {
    const src = join(repoRoot, 'extensions', 'qlb-pi');
    const drift = readdirSync(src).filter((f) => f.endsWith('.ts') && f !== 'tsconfig.json')
      .filter((f) => readText(join(src, f)) !== readText(join(PI_EXT_DIR, f)));
    checks.push(drift.length === 0
      ? { name: 'pi:extension', level: 'PASS', message: `~/.pi/agent/extensions/qlb-pi matches ${src} (pi ${piVersion})` }
      : { name: 'pi:extension', level: 'WARN', message: `installed qlb-pi differs from source: ${drift.join(', ')}`, detail: { fix: `cp ${src}/*.ts ${PI_EXT_DIR}/` } });
  }

  // 2. Pi seams still exported anywhere in the package's declarations. A seam that only survives
  //    in a *legacy*/deprecated declaration file is a WARN: it works today and is scheduled to go.
  const filesByDir = new Map<string, string[]>();
  for (const seam of PI_SEAMS) {
    const dir = join(PI_PKG, seam.dir);
    const files = filesByDir.get(dir) ?? dtsFiles(dir);
    filesByDir.set(dir, files);
    const hits = files.filter((f) => seam.pattern.test(readText(f) ?? ''));
    const rel = hits.map((f) => f.slice(PI_PKG.length + 1));
    const onlyLegacy = hits.length > 0 && rel.every((f) => /legacy|deprecated|compat/i.test(f));
    checks.push({
      name: `pi:seam:${seam.id}`,
      level: hits.length === 0 ? 'FAIL' : onlyLegacy ? 'WARN' : 'PASS',
      message: hits.length === 0
        ? `pi ${piVersion} no longer declares ${seam.id} — ${seam.why}`
        : onlyLegacy
          ? `pi ${piVersion} declares ${seam.id} only in ${rel.join(', ')} (deprecated surface) — plan a qlb-pi migration; ${seam.why}`
          : `pi ${piVersion} declares ${seam.id} (${rel[0]}${rel.length > 1 ? ` +${rel.length - 1}` : ''})`,
      detail: { files: rel },
    });
  }

  // 3. Typecheck the extension against the installed Pi types (catches signature drift, not just renames).
  if (options.typecheck && repoRoot) {
    try {
      run('npx', ['tsc', '-p', join(repoRoot, 'extensions', 'qlb-pi', 'tsconfig.json'), '--noEmit'], { cwd: repoRoot, timeoutMs: 120_000 });
      checks.push({ name: 'pi:typecheck', level: 'PASS', message: `qlb-pi typechecks against pi ${piVersion}` });
    } catch (err) {
      const out = err instanceof Error && 'stdout' in err ? String((err as { stdout?: unknown }).stdout ?? '') : String(err);
      const first = out.split('\n').find((l) => /error TS\d+/.test(l)) ?? out.split('\n')[0];
      checks.push({
        name: 'pi:typecheck', level: 'WARN',
        message: `qlb-pi no longer typechecks against pi ${piVersion}: ${first.slice(0, 160)}`,
        detail: { fix: 'cd ~/GIT/qlb && npx tsc -p extensions/qlb-pi/tsconfig.json --noEmit   # then adapt extensions/qlb-pi and re-sync', errors: out.split('\n').filter((l) => /error TS/.test(l)).slice(0, 10) },
      });
    }
  }

  return checks;
}
