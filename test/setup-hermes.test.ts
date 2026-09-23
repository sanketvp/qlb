import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import { setupHermes } from '../src/setup-hermes';

const REPO_ROOT = join(__dirname, '..', '..');

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

  it('template plugin matches the tracked source of truth (harness/hermes)', () => {
    const tplPlugin = readFileSync(join(REPO_ROOT, 'harness', 'hermes', 'plugin__init__.py'), 'utf8');
    assert.match(tplPlugin, /_SEAM_FUNC = "anthropic_route_is_oauth"/);
    assert.match(tplPlugin, /STATUS_FILE/);
    assert.ok(existsSync(join(REPO_ROOT, 'harness', 'hermes', 'com.qlb.proxy.plist.template')));
    assert.ok(existsSync(join(REPO_ROOT, 'harness', 'hermes', 'com.qlb.hermes-watch.plist.template')));
  });
});
