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
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DoctorCheck } from './diagnostics';

const HERMES_HOME = process.env.HERMES_HOME ?? join(homedir(), '.hermes');
const HERMES_CHECKOUT = join(HERMES_HOME, 'hermes-agent');
const HERMES_CONFIG = join(HERMES_HOME, 'config.yaml');
const HERMES_PYTHON = join(HERMES_CHECKOUT, 'venv', 'bin', 'python');
const PLUGIN_DIR = join(HERMES_HOME, 'plugins', 'model-providers', 'qlb');
const PLUGIN_STATUS = process.env.QLB_HERMES_PLUGIN_STATUS ?? join(homedir(), '.qlb', 'hermes-plugin.json');
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.sanket.qlb-proxy.plist');

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

export function hermesIntegrationChecks(options: HermesIntegrationOptions = {}): DoctorCheck[] {
  const run = options.run ?? defaultRun;
  const checks: DoctorCheck[] = [];

  if (!existsSync(HERMES_CHECKOUT)) {
    checks.push({ name: 'hermes:checkout', level: 'PASS', message: `no Hermes checkout at ${HERMES_CHECKOUT}; skipping Hermes checks` });
    return checks;
  }

  // 1. Hermes config still routes through the proxy with the keys QLB relies on.
  const cfg = readText(HERMES_CONFIG);
  if (cfg == null) {
    checks.push({ name: 'hermes:config', level: 'FAIL', message: `cannot read ${HERMES_CONFIG}` });
  } else {
    const anthropicBlock = /\n\s{2}qlb-anthropic:\n((?:\s{4}.*\n)+)/.exec(cfg)?.[1] ?? '';
    const codexBlock = /\n\s{2}qlb-codex:\n((?:\s{4}.*\n)+)/.exec(cfg)?.[1] ?? '';
    const missing: string[] = [];
    for (const [label, block] of [['qlb-anthropic', anthropicBlock], ['qlb-codex', codexBlock]] as const) {
      if (!block) { missing.push(`${label} (entry absent)`); continue; }
      for (const key of REQUIRED_PROVIDER_KEYS) {
        if (!new RegExp(`^\\s{4}${key}:`, 'm').test(block)) missing.push(`${label}.${key}`);
      }
    }
    if (codexBlock && !/api:\s*https?:\/\/[^\s]+\/v1\s*$/m.test(codexBlock)) {
      missing.push('qlb-codex.api must end in /v1 (Codex Responses posts to <api>/responses)');
    }
    const primaryIsQlb = /^model:\n(?:.*\n)*?\s{2}provider:\s*custom:qlb-anthropic/m.test(cfg);
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
      const cfgPort = /qlb-anthropic:\n(?:\s{4}.*\n)*?\s{4}api:\s*https?:\/\/[^:]+:(\d+)/.exec(cfg ?? '')?.[1];
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

  // 6. Hermes version marker so a drift report can say "since <sha>".
  try {
    const sha = readText(join(HERMES_CHECKOUT, '.git', gitHead.startsWith('ref: ') ? gitHead.slice(5) : 'HEAD'))?.trim().slice(0, 12);
    const mtime = statSync(join(HERMES_CHECKOUT, 'agent', 'anthropic_credentials.py')).mtime.toISOString();
    checks.push({ name: 'hermes:version', level: 'PASS', message: `hermes-agent ${branch}@${sha ?? '?'} (adapter mtime ${mtime})` });
  } catch { /* informational only */ }

  return checks;
}
