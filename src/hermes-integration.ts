/**
 * Hermes ↔ QLB integration health, surfaced through `qlb doctor` as `hermes:*` checks.
 *
 * Nothing here blocks `hermes update` or a Pi/Pyharness upgrade. The contract is: an upgrade may
 * change anything it likes; these checks tell you *what* it changed the moment you (or the
 * launchd watchdog) run `qlb doctor`, so QLB is updated when needed instead of on every release.
 *
 * Checks are read-only, work without a running Hermes, and each names the fix.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { qlbHomeDir } from './home';
import { parseDocument } from 'yaml';
import type { DoctorCheck } from './diagnostics';
import { HERMES_LAUNCHD_LABEL, HERMES_WATCH_LABEL } from './setup-hermes';

const HERMES_HOME = process.env.HERMES_HOME ?? join(qlbHomeDir(), '.hermes');
const HERMES_CHECKOUT = join(HERMES_HOME, 'hermes-agent');
const HERMES_CONFIG = join(HERMES_HOME, 'config.yaml');
const HERMES_PYTHON = join(HERMES_CHECKOUT, 'venv', 'bin', 'python');
const PLUGIN_DIR = join(HERMES_HOME, 'plugins', 'model-providers', 'qlb');
const PLUGIN_STATUS = process.env.QLB_HERMES_PLUGIN_STATUS ?? join(qlbHomeDir(), '.qlb', 'hermes-plugin.json');
// Same label `qlb setup hermes` writes the agent under (QLB_LAUNCHD_LABEL overrides it).
const LAUNCHD_PLIST = join(qlbHomeDir(), 'Library', 'LaunchAgents', `${HERMES_LAUNCHD_LABEL}.plist`);
const WATCH_LAUNCHD_PLIST = join(qlbHomeDir(), 'Library', 'LaunchAgents', `${HERMES_WATCH_LABEL}.plist`);
const HERMES_SCRIPTS = ['qlb-proxy-token', 'qlb-hermes-watch', 'qlb-hermes-models'].map((name) => join(HERMES_HOME, 'scripts', name));

/** Hermes seams QLB depends on: (python module, symbol, expected parameter names or null). */
const HERMES_SEAMS: Array<{ module: string; symbol: string; params: string[] | null; why: string }> = [
  {
    module: 'agent.anthropic_credentials', symbol: 'anthropic_route_is_oauth',
    params: ['base_url', 'credential', 'provider'],
    why: 'plugin extends this so the loopback QLB route gets the Claude Code OAuth payload identity',
  },
  {
    module: 'agent.auxiliary_client', symbol: '_resolve_named_custom_branch', params: null,
    why: 'named custom providers (transport + key_cmd) are resolved here; the raw_codex fix (PR #119677) lives here',
  },
  {
    module: 'hermes_cli.config_providers', symbol: 'normalize_extra_headers', params: null,
    why: 'providers: entry schema (api/transport/key_cmd/session_affinity_header) is parsed by this module',
  },
];

/** providers: entry keys QLB writes; if Hermes stops accepting one, config-check will flag it. */
const REQUIRED_PROVIDER_KEYS = ['api', 'transport', 'key_cmd', 'session_affinity_header'];

export interface HermesIntegrationOptions {
  /** Skip the python seam probe (slow-ish, ~1s). doctor --live turns it on. */
  probeSeams?: boolean;
  run?: (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => string;
}

function defaultRun(cmd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): string {
  // Hermes modules are imported from the checkout, not installed into the venv: cwd matters.
  return execFileSync(cmd, args, {
    encoding: 'utf8', timeout: opts.timeoutMs ?? 20_000, stdio: ['ignore', 'pipe', 'pipe'], cwd: HERMES_CHECKOUT,
    env: { ...process.env, PYTHONWARNINGS: 'ignore', HERMES_HOME, ...(opts.env ?? {}) },
  });
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

type ParsedYaml = { value: unknown } | { error: string };

function parseYaml(text: string): ParsedYaml {
  try {
    // Hermes reads this file with PyYAML, which keeps the last of repeated keys and resolves
    // `<<` merge keys; do the same.
    const doc = parseDocument(text, { uniqueKeys: false, merge: true });
    if (doc.errors.length > 0) return { error: doc.errors[0].message.split(/\r?\n/, 1)[0] };
    return { value: doc.toJS() };
  } catch (error) {
    return { error: error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error) };
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyScalar(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'object'
    && (typeof value !== 'string' || value.trim().length > 0);
}

/**
 * Whether the Hermes config names a QLB provider as a setting: a `qlb-anthropic` /
 * `qlb-codex` mapping key (any value) or a `provider: custom:qlb-…` route.
 */
function parsedValueNamesQlbProvider(value: unknown): boolean {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'qlb-anthropic' || key === 'qlb-codex') return true;
      if (key === 'provider' && typeof child === 'string'
        && (child.trim() === 'custom:qlb-anthropic' || child.trim() === 'custom:qlb-codex')) return true;
      pending.push(child);
    }
  }
  return false;
}

export function yamlNamesQlbProvider(yaml: string): boolean {
  const parsed = parseYaml(yaml);
  return 'error' in parsed || parsedValueNamesQlbProvider(parsed.value);
}

export function hermesIntegrationChecks(options: HermesIntegrationOptions = {}): DoctorCheck[] {
  const run = options.run ?? defaultRun;
  const checks: DoctorCheck[] = [];

  if (!existsSync(HERMES_CHECKOUT)) {
    checks.push({ name: 'hermes:checkout', level: 'PASS', message: `no Hermes checkout at ${HERMES_CHECKOUT}; skipping Hermes checks` });
    return checks;
  }

  // 1. Hermes config still routes through the proxy with the keys QLB relies on.
  const cfg = readText(HERMES_CONFIG);
  const parsedConfig = cfg == null ? null : parseYaml(cfg);
  const configValue = parsedConfig != null && 'value' in parsedConfig ? parsedConfig.value : undefined;

  // Hermes is installed but QLB was never wired into it (or was deliberately unwired). That is
  // "off", not "broken": no config trace, plugin, scripts, or either launchd agent. A config
  // that cannot be read or parsed is not off because we cannot prove it has no QLB trace.
  const configHasQlbTrace = cfg == null ? existsSync(HERMES_CONFIG)
    : parsedConfig != null && 'error' in parsedConfig ? true : parsedValueNamesQlbProvider(configValue);
  const integrationAbsent = !configHasQlbTrace
    && !existsSync(PLUGIN_DIR)
    && !existsSync(LAUNCHD_PLIST)
    && !existsSync(WATCH_LAUNCHD_PLIST)
    && !HERMES_SCRIPTS.some(existsSync);
  if (integrationAbsent) {
    checks.push({
      name: 'hermes:integration', level: 'WARN',
      message: 'Hermes is installed but QLB is not set up for it (no QLB provider entries, plugin, scripts or launchd agents); skipping Hermes checks',
      detail: { fix: 'qlb setup hermes   (only if Hermes should route through QLB)' },
    });
    return checks;
  }

  if (cfg == null) {
    checks.push({ name: 'hermes:config', level: 'FAIL', message: `cannot read ${HERMES_CONFIG}` });
  } else if (parsedConfig != null && 'error' in parsedConfig) {
    checks.push({ name: 'hermes:config', level: 'FAIL', message: `cannot parse ${HERMES_CONFIG}: ${parsedConfig.error}` });
  } else {
    const missing: string[] = [];
    const root = configValue;
    const rawProviders = isMapping(root) ? root.providers : undefined;
    // No providers: section at all means both QLB entries are absent, not a broken section.
    const providers = rawProviders ?? {};
    if (!isMapping(providers)) {
      missing.push('providers (is not a mapping)');
    } else {
      for (const label of ['qlb-anthropic', 'qlb-codex'] as const) {
        if (!Object.hasOwn(providers, label)) { missing.push(`${label} (entry absent)`); continue; }
        const provider = providers[label];
        if (!isMapping(provider)) { missing.push(`${label} (entry is not a mapping)`); continue; }
        for (const key of REQUIRED_PROVIDER_KEYS) {
          if (!hasNonEmptyScalar(provider[key])) missing.push(`${label}.${key}`);
        }
      }
      const codex = providers['qlb-codex'];
      if (isMapping(codex) && hasNonEmptyScalar(codex.api)
        && !(typeof codex.api === 'string' && /^https?:\/\/\S+\/v1$/.test(codex.api.trim()))) {
        missing.push('qlb-codex.api must end in /v1 (Codex Responses posts to <api>/responses)');
      }
    }
    const model = isMapping(root) ? root.model : undefined;
    const primaryIsQlb = isMapping(model) && typeof model.provider === 'string'
      && model.provider.trim() === 'custom:qlb-anthropic';
    if (missing.length > 0) {
      checks.push({
        name: 'hermes:config', level: 'FAIL',
        message: `Hermes providers: entries lost QLB fields: ${missing.join(', ')}`,
        detail: { fix: 'qlb setup hermes  (or restore from ~/.hermes/config.yaml backup)' },
      });
    } else if (!primaryIsQlb) {
      checks.push({
        name: 'hermes:config', level: 'WARN',
        message: 'Hermes model.provider is no longer custom:qlb-anthropic (QLB entries intact, but primary traffic bypasses QLB)',
        detail: { fix: 'hermes config set model.provider custom:qlb-anthropic' },
      });
    } else {
      checks.push({ name: 'hermes:config', level: 'PASS', message: 'qlb-anthropic / qlb-codex entries intact; primary route is QLB' });
    }
  }

  // 2. Plugin present and last load succeeded (status file is rewritten on every Hermes start,
  //    and by the --live seam probe below, which runs provider discovery first).
  const pluginCheck = (): DoctorCheck => {
    if (!existsSync(join(PLUGIN_DIR, '__init__.py'))) {
      return { name: 'hermes:plugin', level: 'FAIL', message: `QLB Hermes plugin missing at ${PLUGIN_DIR}`, detail: { fix: 'qlb setup hermes' } };
    }
    const status = readText(PLUGIN_STATUS);
    if (status == null) {
      return { name: 'hermes:plugin', level: 'WARN', message: 'plugin installed but has not reported a load yet (start Hermes once, or run doctor --live)' };
    }
    try {
      const s = JSON.parse(status) as { ok: boolean; reason: string; written_at: number; plugin_version: string };
      const ageH = Math.round((Date.now() / 1000 - (s.written_at ?? 0)) / 3600);
      return {
        name: 'hermes:plugin', level: s.ok ? 'PASS' : 'FAIL',
        message: s.ok
          ? `plugin v${s.plugin_version} ${s.reason} (last load ${ageH}h ago)`
          : `plugin could NOT patch Hermes: ${s.reason} — Anthropic route will 400 "third-party" until QLB plugin is updated`,
        detail: s,
      };
    } catch {
      return { name: 'hermes:plugin', level: 'WARN', message: `unparseable plugin status at ${PLUGIN_STATUS}` };
    }
  };
  // 3. Local Hermes patch still on the checkout (until PR #119677 lands upstream).
  const gitHead = readText(join(HERMES_CHECKOUT, '.git', 'HEAD'))?.trim() ?? '';
  const branch = gitHead.startsWith('ref: refs/heads/') ? gitHead.slice('ref: refs/heads/'.length) : '(detached)';
  const auxSrc = readText(join(HERMES_CHECKOUT, 'agent', 'auxiliary_client.py')) ?? '';
  const hasRawCodexFix = /if not req\.raw_codex:\s*\n\s*client = CodexAuxiliaryClient\(client, final_model\)/.test(auxSrc)
    // upstream may land an equivalent fix with different text — accept either shape
    || /raw_codex[\s\S]{0,200}CodexAuxiliaryClient\(client, final_model\)/.test(auxSrc) && !/entry_api_mode == "codex_responses":\s*\n\s*client = CodexAuxiliaryClient/.test(auxSrc);
  if (hasRawCodexFix) {
    checks.push({ name: 'hermes:codex-fix', level: 'PASS', message: `named-custom codex_responses raw client fix present (branch ${branch})` });
  } else {
    checks.push({
      name: 'hermes:codex-fix', level: 'FAIL',
      message: `Hermes checkout (branch ${branch}) lacks the raw_codex fix — qlb-codex fallback will send an empty bearer (429 qlb_unauthorized)`,
      detail: { fix: 'cd ~/.hermes/hermes-agent && git cherry-pick 2dc892148d   # or wait for PR NousResearch/hermes-agent#119677', pr: 'https://github.com/NousResearch/hermes-agent/pull/119677' },
    });
  }
  if (branch === 'main') {
    checks.push({
      name: 'hermes:branch', level: 'WARN',
      message: 'Hermes checkout is on main; `hermes update` will not preserve local commits there',
      detail: { fix: 'git checkout -b qlb-local && hermes config set updates.parked_branch_strategy update_in_place' },
    });
  }

  // 4. Proxy supervisor.
  if (process.platform === 'darwin') {
    if (!existsSync(LAUNCHD_PLIST)) {
      checks.push({ name: 'hermes:proxy-supervisor', level: 'WARN', message: `launchd plist missing (${LAUNCHD_PLIST}); proxy will not survive reboot` });
    } else {
      const plist = readText(LAUNCHD_PLIST) ?? '';
      const port = /--port<\/string>\s*<string>(\d+)/.exec(plist)?.[1];
      const providers = isMapping(configValue) ? configValue.providers : undefined;
      const anthropic = isMapping(providers) ? providers['qlb-anthropic'] : undefined;
      let cfgPort: string | undefined;
      if (isMapping(anthropic) && typeof anthropic.api === 'string') {
        try {
          const url = new URL(anthropic.api);
          cfgPort = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '') || undefined;
        } catch { /* unavailable */ }
      }
      if (port && cfgPort && port !== cfgPort) {
        checks.push({ name: 'hermes:proxy-supervisor', level: 'FAIL', message: `launchd proxy port ${port} != Hermes base_url port ${cfgPort}` });
      } else {
        checks.push({ name: 'hermes:proxy-supervisor', level: 'PASS', message: `launchd agent present, port ${port ?? '?'}` });
      }
    }
  }

  // 5. Live seam probe (opt-in): import the exact Hermes symbols the plugin patches.
  if (options.probeSeams && existsSync(HERMES_PYTHON)) {
    const script = [
      'import importlib, inspect, json, os, logging',
      'logging.disable(logging.CRITICAL)',
      'try:',
      '    import providers; providers._discover_providers()  # loads $HERMES_HOME plugins -> qlb plugin rewrites its status',
      'except Exception:',
      '    pass',
      'out = []',
      'for s in json.loads(os.environ["QLB_SEAMS"]):',
      '    name = s["module"] + "." + s["symbol"]',
      '    try:',
      '        fn = getattr(importlib.import_module(s["module"]), s["symbol"])',
      '        fn = getattr(fn, "_qlb_original", fn)',
      '        params = list(inspect.signature(fn).parameters) if callable(fn) else None',
      '        out.append({"seam": name, "ok": s["params"] is None or params == s["params"], "params": params})',
      '    except Exception as e:',
      '        out.append({"seam": name, "ok": False, "error": str(e)})',
      'print(json.dumps(out))',
    ].join('\n');
    try {
      const raw = run(HERMES_PYTHON, ['-c', script], { timeoutMs: 30_000, env: { QLB_SEAMS: JSON.stringify(HERMES_SEAMS.map(({ module, symbol, params }) => ({ module, symbol, params }))) } });
      const line = raw.trim().split('\n').pop() ?? '[]';
      const results = JSON.parse(line) as Array<{ seam: string; ok: boolean; params?: string[]; error?: string }>;
      for (const r of results) {
        const why = HERMES_SEAMS.find((s) => `${s.module}.${s.symbol}` === r.seam)?.why ?? '';
        checks.push({
          name: `hermes:seam:${r.seam.split('.').pop()}`,
          level: r.ok ? 'PASS' : 'FAIL',
          message: r.ok ? `${r.seam} present` : `${r.seam} changed or missing (${r.error ?? `params=${JSON.stringify(r.params)}`}) — ${why}`,
          detail: r,
        });
      }
    } catch (err) {
      checks.push({ name: 'hermes:seam', level: 'WARN', message: `seam probe failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
    }
  }

  checks.push(pluginCheck());

  // 7. Hermes /model picker lists what QLB policies serve (canonical ids, virtual == real).
  try {
    const raw = run(process.env.QLB_BIN ?? 'qlb', ['policy', 'list', '--json'], { timeoutMs: 20_000 });
    const pols = (JSON.parse(raw.slice(raw.indexOf('{'))) as { policies?: Array<{ harness: string; virtualModel: string; realModel: string }> }).policies ?? [];
    const want: Record<string, Set<string>> = { 'qlb-anthropic': new Set(), 'qlb-codex': new Set() };
    for (const p of pols) {
      const prov = p.harness === 'claude-code' ? 'qlb-anthropic' : p.harness === 'codex' ? 'qlb-codex' : null;
      if (prov && p.virtualModel === p.realModel) want[prov].add(p.virtualModel);
    }
    const missing: string[] = [];
    const providers = isMapping(configValue) ? configValue.providers : undefined;
    for (const [prov, models] of Object.entries(want)) {
      const provider = isMapping(providers) ? providers[prov] : undefined;
      const configuredModels = isMapping(provider) && isMapping(provider.models) ? provider.models : undefined;
      for (const m of models) if (!configuredModels || !Object.hasOwn(configuredModels, m)) missing.push(`${prov}/${m}`);
    }
    checks.push(missing.length === 0
      ? { name: 'hermes:models', level: 'PASS', message: `Hermes /model picker lists all ${Object.values(want).reduce((n, s) => n + s.size, 0)} QLB-served models` }
      : { name: 'hermes:models', level: 'WARN', message: `Hermes /model picker is missing QLB models: ${missing.join(', ')}`, detail: { fix: '~/.hermes/scripts/qlb-hermes-models   (or qlb setup hermes)' } });
  } catch (err) {
    checks.push({ name: 'hermes:models', level: 'WARN', message: `could not compare picker with policies: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
  }

  // 6. Hermes version marker so a drift report can say "since <sha>".
  try {
    const sha = readText(join(HERMES_CHECKOUT, '.git', gitHead.startsWith('ref: ') ? gitHead.slice(5) : 'HEAD'))?.trim().slice(0, 12);
    const mtime = statSync(join(HERMES_CHECKOUT, 'agent', 'anthropic_credentials.py')).mtime.toISOString();
    checks.push({ name: 'hermes:version', level: 'PASS', message: `hermes-agent ${branch}@${sha ?? '?'} (adapter mtime ${mtime})` });
  } catch { /* informational only */ }

  return checks;
}
