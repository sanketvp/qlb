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
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DoctorCheck } from './diagnostics';
import { qlbHomeDir } from './home';
import { piSharedSrcDirFor } from './pi-deploy';
import { findQlbRepoRoot } from './setup';

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const OPENROUTER_MODELS_JSON_BLOCKED = 'models.json openrouter block prevents QLB from managing OpenRouter — fix or remove it';

function isPiPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    return pkg.name === PI_PACKAGE_NAME;
  } catch {
    return false;
  }
}

export interface PiLocation {
  /** Package root of the Pi the user runs, or null. */
  root: string | null;
  /** First `pi` launcher found on PATH (the one a shell would run), if any. */
  launcher?: string;
  /** A launcher exists but its package could not be located (e.g. a compiled shim). */
  unresolved?: boolean;
}

function walkUpToPiRoot(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 8 && cur !== dirname(cur); i++, cur = dirname(cur)) {
    if (isPiPackageRoot(cur)) return cur;
  }
  return null;
}

/** Script shims (npm .cmd/.ps1/sh wrappers) name the package path in their text. */
function rootFromShimText(launcher: string): string | null {
  let text: string;
  try {
    const buf = readFileSync(launcher);
    if (buf.length > 64 * 1024 || buf.includes(0)) return null; // binary shim
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  const re = /([^\s"'`=]*@earendil-works[\\/]pi-coding-agent)(?=[\\/"'`\s]|$)/g;
  for (const match of text.matchAll(re)) {
    const raw = match[1]!
      .replace(/^(%~dp0|%dp0%|\$basedir|\$\{basedir\}|\$PSScriptRoot)[\\/]?/i, '')
      .replace(/\\/g, '/');
    const candidate = isAbsolute(raw) ? raw : join(dirname(launcher), raw);
    if (isPiPackageRoot(candidate)) return candidate;
  }
  return null;
}

/**
 * Fleet runtime selector (~/.pi/agent/bin/pi, reached via ~/.pi/agent/runtimes/bin):
 * it execs "$RUNTIME_ROOT/node_modules/@earendil-works/pi-coding-agent" where
 * RUNTIME_ROOT is the resolved ~/.pi/agent/runtimes/current. The variable can't be
 * read from the text, so follow the selector symlink it names.
 */
function rootFromRuntimeSelector(launcher: string, home: string): string | null {
  let text: string;
  try {
    text = readFileSync(launcher, 'utf8');
  } catch {
    return null;
  }
  if (!/runtimes\/current/.test(text) || !/node_modules\/@earendil-works\/pi-coding-agent/.test(text)) return null;
  const candidate = join(home, '.pi', 'agent', 'runtimes', 'current', 'node_modules', '@earendil-works', 'pi-coding-agent');
  try {
    const real = realpathSync(candidate);
    return isPiPackageRoot(real) ? real : null;
  } catch {
    return null;
  }
}

function launcherNames(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return ['pi'];
  // PowerShell model (the documented Windows workflow): pi.ps1 first (PowerShell
  // runs scripts even when .PS1 is not in PATHEXT), then PATHEXT names in order;
  // an extensionless `pi` (npm's sh shim) is not runnable there.
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  return ['pi.ps1', ...exts.filter((e) => e !== '.ps1').map((e) => `pi${e}`)];
}

/** PATH entries in shell search order. Unset PATH searches nothing. */
function pathEntries(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (env.PATH === undefined) return [];
  const parts = env.PATH.split(platform === 'win32' ? ';' : delimiter);
  // POSIX shells read an empty entry as the current directory; PowerShell ignores it.
  return platform === 'win32' ? parts.filter(Boolean) : parts.map((d) => d || '.');
}

/**
 * Locate the Pi install the user actually runs: QLB_PI_PACKAGE_ROOT if set; else the
 * package behind the FIRST `pi` launcher on PATH (symlink target, or the path named
 * in a script shim). If that launcher cannot be traced, report it as unresolved
 * rather than falling through to a later, possibly stale install. Well-known npm
 * global prefixes are consulted only when no `pi` is on PATH at all.
 */
export function locatePi(
  env: NodeJS.ProcessEnv = process.env,
  home: string = qlbHomeDir(env),
  platform: NodeJS.Platform = process.platform,
): PiLocation {
  const override = env.QLB_PI_PACKAGE_ROOT ? resolve(env.QLB_PI_PACKAGE_ROOT) : undefined;
  if (override) return isPiPackageRoot(override) ? { root: override } : { root: null, unresolved: true };
  const names = launcherNames(platform, env);
  for (const dir of pathEntries(platform, env)) {
    for (const name of names) {
      const bin = resolve(dir, name); // absolute even for a '.' (cwd) PATH entry
      try {
        if (!statSync(bin).isFile()) continue; // a shell skips directories named pi
        accessSync(bin, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      } catch {
        continue;
      }
      let root: string | null = null;
      try {
        root = walkUpToPiRoot(dirname(realpathSync(bin)));
      } catch {
        root = null;
      }
      root ??= rootFromShimText(bin) ?? rootFromRuntimeSelector(bin, home);
      return root ? { root, launcher: bin } : { root: null, launcher: bin, unresolved: true };
    }
  }
  for (const prefix of [join(home, '.local'), '/opt/homebrew', '/usr/local']) {
    const candidate = join(prefix, 'lib', 'node_modules', ...PI_PACKAGE_NAME.split('/'));
    if (isPiPackageRoot(candidate)) return { root: candidate };
  }
  return { root: null };
}

export function resolvePiPackageRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = qlbHomeDir(env),
): string | null {
  return locatePi(env, home).root;
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
  /** Pi agent directory; tests inject a temporary directory. */
  agentDir?: string;
  /** Run `tsc --noEmit` against the installed Pi types (slow, ~3s). doctor --live turns it on. */
  typecheck?: boolean;
  /** Pi location; defaults to locatePi(). */
  pi?: PiLocation;
  /** Installed extension directory; defaults to ~/.pi/agent/extensions/qlb-pi. */
  extensionDir?: string;
  run?: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => string;
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pi config.ts getAgentDir(): PI_CODING_AGENT_DIR, then ~/.pi/agent. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = qlbHomeDir(env)): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return join(home, '.pi', 'agent');
  if (configured === '~') return home;
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(home, configured.slice(2));
  return configured;
}

function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ''));
}

/**
 * Exact provider-level rejection rule from Pi 1.4.0
 * dist/core/provider-composer.js applyModelsJson(). ModelConfig discards an
 * invalid whole file, so malformed files intentionally produce no block here.
 */
export function openRouterModelsJsonRegistrationError(path: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonComments(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))); } catch { return undefined; }
  const config = isRecord(parsed) && isRecord(parsed.providers) && isRecord(parsed.providers.openrouter)
    ? parsed.providers.openrouter
    : undefined;
  if (!config) return undefined;
  // Keep malformed provider fields out of this check: Pi's ModelConfig schema
  // makes the entire models.json map empty before applyModelsJson can run.
  if ((config.baseUrl !== undefined && typeof config.baseUrl !== 'string') ||
      (config.apiKey !== undefined && typeof config.apiKey !== 'string') ||
      (config.oauth !== undefined && config.oauth !== 'radius') ||
      (config.authHeader !== undefined && typeof config.authHeader !== 'boolean') ||
      (config.headers !== undefined && (!isRecord(config.headers) || Object.values(config.headers).some((v) => typeof v !== 'string'))) ||
      (config.compat !== undefined && !isRecord(config.compat)) ||
      (config.models !== undefined && !Array.isArray(config.models)) ||
      (config.modelOverrides !== undefined && !isRecord(config.modelOverrides))) return undefined;
  if (config.oauth && !config.baseUrl) return 'Provider openrouter: "baseUrl" is required when "oauth" is set.';
  const hasOverrides = isRecord(config.modelOverrides) && Object.keys(config.modelOverrides).length > 0;
  if (!Array.isArray(config.models) || config.models.length === 0) {
    if (!config.baseUrl && !config.headers && !config.compat && !hasOverrides &&
        !config.apiKey && !config.oauth && config.authHeader === undefined) {
      return 'Provider openrouter: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".';
    }
  }
  return undefined;
}

function qlbOwnsOpenRouter(agentDir: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(agentDir, 'qlb-owner.json'), 'utf8')) as unknown;
    const openrouter = isRecord(owner) && isRecord(owner.providers) ? owner.providers.openrouter : undefined;
    return isRecord(openrouter) && openrouter.mode === 'qlb' &&
      typeof openrouter.since === 'number' && Number.isFinite(openrouter.since) && openrouter.since >= 0;
  } catch {
    return false;
  }
}

/** Source-relative TypeScript files, including provider modules below qlb-pi/. */
function extensionTypeScriptFiles(dir: string, prefix = ''): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const relative = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) return extensionTypeScriptFiles(join(dir, entry.name), relative);
      return entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'tsconfig.json' ? [relative] : [];
    });
  } catch {
    return [];
  }
}

export function piIntegrationChecks(options: PiIntegrationOptions = {}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const run = options.run ?? ((cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number } = {}) =>
    execFileSync(cmd, args, { encoding: 'utf8', cwd: o.cwd, timeout: o.timeoutMs ?? 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));

  const agentDir = options.agentDir ?? piAgentDir();
  const PI_EXT_DIR = options.extensionDir ?? join(agentDir, 'extensions', 'qlb-pi');
  const located = options.pi ?? locatePi();
  if (located.unresolved && existsSync(PI_EXT_DIR)) {
    checks.push({
      name: 'pi:extension',
      level: 'WARN',
      message: `found ${located.launcher ?? 'QLB_PI_PACKAGE_ROOT'} but could not locate its @earendil-works/pi-coding-agent package; Pi checks skipped`,
      detail: { fix: 'export QLB_PI_PACKAGE_ROOT=<path to the pi-coding-agent package your pi runs>' },
    });
    return checks;
  }
  const PI_PKG = located.root;
  if (!PI_PKG) {
    checks.push({ name: 'pi:extension', level: 'PASS', message: 'Pi or the qlb-pi extension is not installed; skipping Pi checks' });
    return checks;
  }
  let sharedSrcDir: string;
  try {
    sharedSrcDir = piSharedSrcDirFor(PI_EXT_DIR);
  } catch (err) {
    checks.push({
      name: 'pi:extension',
      level: 'WARN',
      message: `installed qlb-pi shared sources are unavailable: ${err instanceof Error ? err.message : String(err)}`,
      detail: { fix: 'repair the ~/.pi/agent/extensions link, then run qlb pi deploy' },
    });
    return checks;
  }
  if (!existsSync(PI_EXT_DIR)) {
    checks.push({ name: 'pi:extension', level: 'PASS', message: 'Pi or the qlb-pi extension is not installed; skipping Pi checks' });
    return checks;
  }

  const piVersion = (() => { try { return (JSON.parse(readText(join(PI_PKG, 'package.json')) ?? '{}') as { version?: string }).version ?? '?'; } catch { return '?'; } })();

  // Pi rejects this models.json block before it can apply QLB's replacement.
  // Do not let the native provider silently retain its configured API key.
  if (qlbOwnsOpenRouter(agentDir) && openRouterModelsJsonRegistrationError(join(agentDir, 'models.json'))) {
    checks.push({ name: 'pi:models-json-openrouter', level: 'FAIL', message: OPENROUTER_MODELS_JSON_BLOCKED });
  }

  // 1. Installed extension == tracked source (a QLB upgrade that touches extensions/qlb-pi must be re-synced).
  // Shared files live beside the real (resolved) extensions directory, via piSharedSrcDirFor.
  const repoRoot = findQlbRepoRoot();
  if (repoRoot) {
    const src = join(repoRoot, 'extensions', 'qlb-pi');
    const installedRedact = join(sharedSrcDir, 'redact.ts');
    const installedOwnerDocument = join(sharedSrcDir, 'pi-owner-document.ts');
    const sourceFiles = extensionTypeScriptFiles(src);
    const installedFiles = extensionTypeScriptFiles(PI_EXT_DIR);
    const drift = [
      ...sourceFiles.filter((file) => readText(join(src, file)) !== readText(join(PI_EXT_DIR, file))),
      ...installedFiles.filter((file) => !sourceFiles.includes(file)),
      ...(readText(join(repoRoot, 'src', 'redact.ts')) === readText(installedRedact) ? [] : ['src/redact.ts']),
      ...(readText(join(repoRoot, 'src', 'pi-owner-document.ts')) === readText(installedOwnerDocument) ? [] : ['src/pi-owner-document.ts']),
    ];

    checks.push(drift.length === 0
      ? { name: 'pi:extension', level: 'PASS', message: `${PI_EXT_DIR} matches ${src} (pi ${piVersion} at ${PI_PKG})` }
      : {
        name: 'pi:extension', level: 'WARN', message: `installed qlb-pi differs from source: ${drift.join(', ')}`,
        // `qlb pi deploy` publishes a staged whole-directory replacement, so it
        // removes stale nested files as well as copying the current extension.
        detail: { fix: 'qlb pi deploy' },
      });
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
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'qlb-pi-typecheck-'));
      const cfg = join(tmp, 'tsconfig.json');
      writeFileSync(cfg, JSON.stringify(piTypecheckConfig(join(repoRoot, 'extensions', 'qlb-pi'), PI_PKG)));
      run('npx', ['tsc', '-p', cfg, '--noEmit'], { cwd: repoRoot, timeoutMs: 120_000 });
      checks.push({ name: 'pi:typecheck', level: 'PASS', message: `qlb-pi typechecks against pi ${piVersion}` });
    } catch (err) {
      if (!tmp) {
        checks.push({
          name: 'pi:typecheck', level: 'WARN',
          message: `could not create a temporary directory for the typecheck: ${err instanceof Error ? err.message : String(err)}`,
        });
        return checks;
      }
      const out = err instanceof Error && 'stdout' in err ? String((err as { stdout?: unknown }).stdout ?? '') : String(err);
      const first = out.split('\n').find((l) => /error TS\d+/.test(l)) ?? out.split('\n')[0];
      checks.push({
        name: 'pi:typecheck', level: 'WARN',
        message: `qlb-pi no longer typechecks against pi ${piVersion}: ${first.slice(0, 160)}`,
        detail: { fix: `qlb doctor --live   # typechecks extensions/qlb-pi against ${PI_PKG}; then adapt extensions/qlb-pi and re-sync`, errors: out.split('\n').filter((l) => /error TS/.test(l)).slice(0, 10) },
      });
    } finally {
      try {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort: a leftover temp dir must not replace the typecheck result
      }
    }
  }

  return checks;
}
