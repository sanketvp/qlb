/**
 * `qlb setup hermes` — install/refresh every QLB artifact that lives OUTSIDE the Hermes checkout.
 *
 * Idempotent and byte-comparing: re-running after a QLB upgrade updates only files whose
 * content changed, and reports each one. Nothing here touches `~/.hermes/hermes-agent`, so a
 * `hermes update` can never delete it, and nothing here edits `~/.hermes/config.yaml` — the
 * config commands are printed for the user (Hermes owns that file's schema/migrations).
 *
 * Artifacts:
 *   ~/.hermes/plugins/model-providers/qlb/{__init__.py,plugin.yaml}  (OAuth-route predicate)
 *   ~/.hermes/scripts/qlb-proxy-token                                  (key_cmd helper)
 *   ~/Library/LaunchAgents/<label>.plist                                (proxy supervisor, macOS)
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { findQlbRepoRoot } from './setup';

export const HERMES_DEFAULT_PORT = 47391;
export const HERMES_LAUNCHD_LABEL = process.env.QLB_LAUNCHD_LABEL ?? 'com.sanket.qlb-proxy';
export const HERMES_WATCH_LABEL = process.env.QLB_WATCH_LABEL ?? 'com.sanket.qlb-hermes-watch';

export interface HermesSetupOptions {
  hermesHome?: string;
  home?: string;
  repoRoot?: string | null;
  port?: number;
  qlbBin?: string;
  /** Skip launchd bootstrap (tests / non-macOS). */
  noLaunchd?: boolean;
  run?: (cmd: string, args: string[]) => string;
}

export interface HermesSetupFile {
  path: string;
  action: 'created' | 'updated' | 'unchanged';
}

export interface HermesSetupResult {
  harness: 'hermes';
  files: HermesSetupFile[];
  launchd?: { label: string; action: 'bootstrapped' | 'restarted' | 'skipped'; detail?: string };
  watch?: { label: string; action: 'bootstrapped' | 'restarted' | 'skipped'; detail?: string };
  instructions: string;
}

function writeIfChanged(path: string, content: string, mode?: number): HermesSetupFile {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) {
    if (mode !== undefined) chmodSync(path, mode);
    return { path, action: 'unchanged' };
  }
  writeFileSync(path, content, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) });
  if (mode !== undefined) chmodSync(path, mode);
  return { path, action: existed ? 'updated' : 'created' };
}

function defaultQlbBin(): string {
  try {
    return execFileSync('/bin/sh', ['-lc', 'command -v qlb'], { encoding: 'utf8' }).trim() || 'qlb';
  } catch {
    return 'qlb';
  }
}

export function hermesInstructions(opts: { hermesHome: string; port: number; keyCmd: string }): string {
  const base = `http://127.0.0.1:${opts.port}`;
  return [
    'Hermes ↔ QLB (named custom providers; nothing inside the hermes-agent checkout)',
    '',
    'Config (run once; re-running is harmless):',
    `  hermes config set providers.qlb-anthropic.api ${base}`,
    '  hermes config set providers.qlb-anthropic.transport anthropic_messages',
    `  hermes config set providers.qlb-anthropic.key_cmd ${opts.keyCmd}`,
    '  hermes config set providers.qlb-anthropic.session_affinity_header x-qlb-session',
    '  hermes config set providers.qlb-anthropic.discover_models false',
    `  hermes config set providers.qlb-codex.api ${base}/v1        # /v1 is required for Codex Responses`,
    '  hermes config set providers.qlb-codex.transport codex_responses',
    `  hermes config set providers.qlb-codex.key_cmd ${opts.keyCmd}`,
    '  hermes config set providers.qlb-codex.session_affinity_header x-qlb-session',
    '  hermes config set providers.qlb-codex.discover_models false',
    '  hermes config set model.provider custom:qlb-anthropic',
    `  hermes config set model.base_url ${base}`,
    '  hermes config set model.api_mode anthropic_messages',
    '  hermes config set updates.parked_branch_strategy update_in_place   # keep local commits across hermes update',
    '',
    'Policies: every model Hermes may request needs a QLB policy, e.g.',
    '  qlb policy set --harness claude-code --virtual-model claude-opus-5.5 --real-model claude-opus-5-5 --effort high',
    '  qlb policy set --harness codex --virtual-model gpt-5.6-sol --real-model gpt-5.6-sol --effort medium',
    '',
    'Verify:  qlb doctor --live      (hermes:* checks)   then   hermes chat -q "Reply: OK"',
  ].join('\n');
}

export function setupHermes(opts: HermesSetupOptions = {}): HermesSetupResult {
  const home = opts.home ?? homedir();
  const hermesHome = opts.hermesHome ?? process.env.HERMES_HOME ?? join(home, '.hermes');
  const repoRoot = opts.repoRoot === undefined ? findQlbRepoRoot() : opts.repoRoot;
  if (!repoRoot) throw new Error('qlb setup hermes: cannot locate the qlb repo root (harness/hermes templates)');
  const tpl = join(repoRoot, 'harness', 'hermes');
  const port = opts.port ?? HERMES_DEFAULT_PORT;
  const qlbBin = opts.qlbBin ?? defaultQlbBin();
  const files: HermesSetupFile[] = [];

  const pluginDir = join(hermesHome, 'plugins', 'model-providers', 'qlb');
  files.push(writeIfChanged(join(pluginDir, '__init__.py'), readFileSync(join(tpl, 'plugin__init__.py'), 'utf8')));
  files.push(writeIfChanged(join(pluginDir, 'plugin.yaml'), readFileSync(join(tpl, 'plugin.yaml'), 'utf8')));

  const keyCmd = join(hermesHome, 'scripts', 'qlb-proxy-token');
  files.push(writeIfChanged(keyCmd, readFileSync(join(tpl, 'qlb-proxy-token'), 'utf8'), 0o755));
  const watchScript = join(hermesHome, 'scripts', 'qlb-hermes-watch');
  files.push(writeIfChanged(watchScript, readFileSync(join(tpl, 'qlb-hermes-watch'), 'utf8'), 0o755));

  let launchd: HermesSetupResult['launchd'];
  let watch: HermesSetupResult['watch'];
  if (process.platform === 'darwin' && !opts.noLaunchd) {
    const run = opts.run ?? ((cmd: string, args: string[]) =>
      execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const uid = process.getuid?.() ?? 501;
    const installAgent = (label: string, template: string, mutate: (s: string) => string = (s) => s) => {
      const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
      const plist = mutate(readFileSync(join(tpl, template), 'utf8')
        .replaceAll('__HOME__', home)
        .replaceAll('__LABEL__', label)
        .replaceAll('__QLB_BIN__', qlbBin));
      const f = writeIfChanged(plistPath, plist);
      files.push(f);
      try {
        if (f.action === 'unchanged') {
          return { label, action: 'skipped' as const, detail: 'plist unchanged; agent left as is' };
        }
        try { run('launchctl', ['bootout', `gui/${uid}/${label}`]); } catch { /* not loaded */ }
        run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
        return { label, action: f.action === 'created' ? 'bootstrapped' as const : 'restarted' as const };
      } catch (err) {
        return { label, action: 'skipped' as const, detail: err instanceof Error ? err.message.split('\n')[0] : String(err) };
      }
    };
    launchd = installAgent(HERMES_LAUNCHD_LABEL, 'com.qlb.proxy.plist.template', (s) =>
      s.replace(/<string>--port<\/string><string>\d+<\/string>/, `<string>--port</string><string>${port}</string>`));
    watch = installAgent(HERMES_WATCH_LABEL, 'com.qlb.hermes-watch.plist.template');
  }

  return {
    harness: 'hermes',
    files,
    ...(launchd ? { launchd } : {}),
    ...(watch ? { watch } : {}),
    instructions: hermesInstructions({ hermesHome, port, keyCmd }),
  };
}
