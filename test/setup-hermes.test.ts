import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it, after } from 'node:test';
import { setupHermes } from '../src/setup-hermes';

const REPO_ROOT = join(__dirname, '..', '..');
const SETUP_HERMES_MODULE = join(__dirname, '..', 'src', 'setup-hermes.js');

describe('setup hermes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qlb-setup-hermes-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('installs plugin, key_cmd and watchdog outside the hermes-agent checkout, idempotently', () => {
    const home = join(tmp, 'home');
    const hermesHome = join(home, '.hermes');
    mkdirSync(join(hermesHome, 'hermes-agent'), { recursive: true });

    const first = setupHermes({ home, hermesHome, repoRoot: REPO_ROOT, noLaunchd: true });
    assert.equal(first.harness, 'hermes');
    const created = first.files.filter((f) => f.action === 'created').map((f) => f.path);
    assert.ok(created.some((p) => p.endsWith('/plugins/model-providers/qlb/__init__.py')));
    assert.ok(created.some((p) => p.endsWith('/plugins/model-providers/qlb/plugin.yaml')));
    assert.ok(created.some((p) => p.endsWith('/scripts/qlb-proxy-token')));
    assert.ok(created.some((p) => p.endsWith('/scripts/qlb-hermes-watch')));
    // Never writes into the Hermes checkout.
    for (const f of first.files) assert.ok(!f.path.includes('/hermes-agent/'), f.path);
    assert.match(first.instructions, /providers\.qlb-codex\.api http:\/\/127\.0\.0\.1:47391\/v1/);

    const second = setupHermes({ home, hermesHome, repoRoot: REPO_ROOT, noLaunchd: true });
    assert.deepEqual(new Set(second.files.map((f) => f.action)), new Set(['unchanged']));

    // A drifted file is repaired, others untouched.
    const keyCmd = join(hermesHome, 'scripts', 'qlb-proxy-token');
    writeFileSync(keyCmd, '#!/bin/bash\necho stale\n');
    const third = setupHermes({ home, hermesHome, repoRoot: REPO_ROOT, noLaunchd: true });
    assert.equal(third.files.find((f) => f.path === keyCmd)?.action, 'updated');
    assert.equal(third.files.filter((f) => f.action !== 'unchanged').length, 1);
    assert.equal(readFileSync(keyCmd, 'utf8'), readFileSync(join(REPO_ROOT, 'harness', 'hermes', 'qlb-proxy-token'), 'utf8'));
  });

  function watchPlistFor(name: string, env: NodeJS.ProcessEnv = {}): string {
    const home = join(tmp, name);
    const hermesHome = join(home, '.hermes');
    // Isolation: the models script setupHermes runs must never reach a real hermes/~/.hermes.
    // The script honours QLB_BIN and HERMES_BIN (not HERMES_HOME); we pin all of them plus a PATH stub.
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stubLog = join(home, 'hermes-stub.log');
    const stub = join(binDir, 'hermes');
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(stubLog)}\nexit 1\n`);
    chmodSync(stub, 0o755);
    const watchLabel = env.QLB_WATCH_LABEL ?? 'com.sanket.qlb-hermes-watch';
    return execFileSync(
      process.execPath,
      ['-e', `
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const { setupHermes } = require(${JSON.stringify(SETUP_HERMES_MODULE)});
        setupHermes({
          home: ${JSON.stringify(home)},
          hermesHome: ${JSON.stringify(hermesHome)},
          repoRoot: ${JSON.stringify(REPO_ROOT)},
          qlbBin: '/no-such-qlb',
          run: () => '',
        });
        process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(home, 'Library', 'LaunchAgents', `${watchLabel}.plist`))}, 'utf8'));
      `],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          QLB_BIN: '/no-such-qlb',
          HERMES_HOME: hermesHome,
          HERMES_BIN: '/no-such-hermes',
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );
  }

  function stubLogFor(name: string): string {
    const log = join(tmp, name, 'hermes-stub.log');
    return existsSync(log) ? readFileSync(log, 'utf8') : '';
  }

  it('writes default proxy and watch labels into the watch agent environment', () => {
    const plist = watchPlistFor('watch-default-labels');
    assert.match(plist, /<key>QLB_LAUNCHD_LABEL<\/key><string>com\.sanket\.qlb-proxy<\/string>/);
    assert.match(plist, /<key>QLB_WATCH_LABEL<\/key><string>com\.sanket\.qlb-hermes-watch<\/string>/);
    assert.doesNotMatch(stubLogFor('watch-default-labels'), /config set/);
  });

  it('writes a custom proxy label into the watch agent environment', () => {
    const plist = watchPlistFor('watch-custom-proxy-label', { QLB_LAUNCHD_LABEL: 'com.example.proxy' });
    assert.match(plist, /<key>QLB_LAUNCHD_LABEL<\/key><string>com\.example\.proxy<\/string>/);
  });

  it('XML-escapes a custom proxy label in the watch plist and keeps it well-formed', () => {
    const name = 'watch-escaped-proxy-label';
    const plist = watchPlistFor(name, { QLB_LAUNCHD_LABEL: 'com.example&proxy<x' });
    assert.match(plist, /<key>QLB_LAUNCHD_LABEL<\/key><string>com\.example&amp;proxy&lt;x<\/string>/);
    assert.doesNotMatch(plist, /com\.example&proxy<x/);
    assert.doesNotMatch(stubLogFor(name), /config set/);
    if (process.platform === 'darwin') {
      const file = join(tmp, name, 'watch.plist');
      writeFileSync(file, plist);
      const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    }
  });

  it('XML-escapes custom watch labels in the watch plist', () => {
    const plist = watchPlistFor('watch-escaped-label', { QLB_WATCH_LABEL: 'com.example&watch' });
    assert.match(plist, /<key>Label<\/key><string>com\.example&amp;watch<\/string>/);
    assert.match(plist, /<key>QLB_WATCH_LABEL<\/key><string>com\.example&amp;watch<\/string>/);
  });

  it('template plugin matches the tracked source of truth (harness/hermes)', () => {
    const tplPlugin = readFileSync(join(REPO_ROOT, 'harness', 'hermes', 'plugin__init__.py'), 'utf8');
    assert.match(tplPlugin, /_SEAM_FUNC = "anthropic_route_is_oauth"/);
    assert.match(tplPlugin, /STATUS_FILE/);
    assert.ok(existsSync(join(REPO_ROOT, 'harness', 'hermes', 'com.qlb.proxy.plist.template')));
    assert.ok(existsSync(join(REPO_ROOT, 'harness', 'hermes', 'com.qlb.hermes-watch.plist.template')));
  });
});
