/**
 * Pi ↔ QLB integration health, surfaced through `qlb doctor` as `pi:*` checks.
 *
 * Pi (`@earendil-works/pi-coding-agent`, global npm) may upgrade freely. The qlb-pi extension
 * depends on a few Pi seams (ExtensionAPI events, `@earendil-works/pi-ai/compat`
 * `anthropicMessagesApi().streamSimple`). These checks report when a Pi upgrade moved them,
 * and whether the installed extension copy matches the tracked source.
 */
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { DoctorCheck } from './diagnostics';
import { findQlbRepoRoot } from './setup';

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const PI_EXT_DIR = join(homedir(), '.pi', 'agent', 'extensions', 'qlb-pi');

function isPiPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    return pkg.name === PI_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * The Pi install the user actually runs: QLB_PI_PACKAGE_ROOT if set, else the package
 * that the first executable `pi` on PATH resolves into (npm global prefixes differ per
 * machine — e.g. ~/.local vs /opt/homebrew — and `pi update` installs into its own
 * prefix), else well-known global prefixes. null when Pi is not installed.
 */
export function resolvePiPackageRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const override = env.QLB_PI_PACKAGE_ROOT;
  if (override) return isPiPackageRoot(override) ? override : null;
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const bin = join(dir, 'pi');
    try {
      accessSync(bin, fsConstants.X_OK);
    } catch {
      continue;
    }
    let cur: string;
    try {
      cur = dirname(realpathSync(bin));
    } catch {
      continue;
    }
    // Walk up from the resolved entry script to its package root.
    for (let i = 0; i < 8 && cur !== dirname(cur); i++, cur = dirname(cur)) {
      if (isPiPackageRoot(cur)) return cur;
    }
  }
  for (const prefix of [join(home, '.local'), '/opt/homebrew', '/usr/local']) {
    const candidate = join(prefix, 'lib', 'node_modules', ...PI_PACKAGE_NAME.split('/'));
    if (isPiPackageRoot(candidate)) return candidate;
  }
  return null;
}

/**
 * The extension's tsconfig.json pins one machine's Pi paths; doctor typechecks
 * against the resolved install through a generated config instead.
 */
export function piTypecheckConfig(extensionDir: string, piRoot: string): Record<string, unknown> {
  const base = JSON.parse(readFileSync(join(extensionDir, 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: Record<string, unknown>;
  };
  const piAi = join(piRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist');
  return {
    compilerOptions: {
      ...base.compilerOptions,
      typeRoots: [join(piRoot, 'node_modules', '@types')],
      paths: {
        '@earendil-works/pi-coding-agent': [join(piRoot, 'dist', 'index.d.ts')],
        '@earendil-works/pi-ai': [join(piAi, 'index.d.ts')],
        '@earendil-works/pi-ai/*': [join(piAi, '*.d.ts')],
        '@earendil-works/pi-tui': [join(piRoot, 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'index.d.ts')],
      },
    },
    include: [join(extensionDir, '*.ts')],
  };
}
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
  let entries: Dirent[] = [];
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
  /** Pi package root; defaults to resolvePiPackageRoot(). */
  piRoot?: string | null;
  run?: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => string;
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

export function piIntegrationChecks(options: PiIntegrationOptions = {}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const run = options.run ?? ((cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number } = {}) =>
    execFileSync(cmd, args, { encoding: 'utf8', cwd: o.cwd, timeout: o.timeoutMs ?? 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));

  const PI_PKG = options.piRoot === undefined ? resolvePiPackageRoot() : options.piRoot;
  if (!PI_PKG || !existsSync(PI_EXT_DIR)) {
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
      ? { name: 'pi:extension', level: 'PASS', message: `~/.pi/agent/extensions/qlb-pi matches ${src} (pi ${piVersion} at ${PI_PKG})` }
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
    const tmp = mkdtempSync(join(tmpdir(), 'qlb-pi-typecheck-'));
    try {
      const cfg = join(tmp, 'tsconfig.json');
      writeFileSync(cfg, JSON.stringify(piTypecheckConfig(join(repoRoot, 'extensions', 'qlb-pi'), PI_PKG)));
      run('npx', ['tsc', '-p', cfg, '--noEmit'], { cwd: repoRoot, timeoutMs: 120_000 });
      checks.push({ name: 'pi:typecheck', level: 'PASS', message: `qlb-pi typechecks against pi ${piVersion}` });
    } catch (err) {
      const out = err instanceof Error && 'stdout' in err ? String((err as { stdout?: unknown }).stdout ?? '') : String(err);
      const first = out.split('\n').find((l) => /error TS\d+/.test(l)) ?? out.split('\n')[0];
      checks.push({
        name: 'pi:typecheck', level: 'WARN',
        message: `qlb-pi no longer typechecks against pi ${piVersion}: ${first.slice(0, 160)}`,
        detail: { fix: `qlb doctor --live   # typechecks extensions/qlb-pi against ${PI_PKG}; then adapt extensions/qlb-pi and re-sync`, errors: out.split('\n').filter((l) => /error TS/.test(l)).slice(0, 10) },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  return checks;
}
