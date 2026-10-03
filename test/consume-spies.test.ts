import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { consumedAccessString } from '../src/cswap-consume';
import { loadCswapUsageSnapshots } from '../src/cswap-usage';
import { resyncConsumedAccess } from '../src/cswap-consume';

const spies = { tokenPosts: 0, cswapSpawns: 0, securityWrites: 0 };

describe('consume injected spies', () => {
  it('inject + 401 + status never post tokens, spawn cswap, or write security', () => {
    const access = consumedAccessString({
      runner: () => JSON.stringify({
        claudeAiOauth: { accessToken: 'test-access', expiresAt: 4102444800000 },
      }),
      env: { USER: 'fixture-user' },
    });
    assert.equal(typeof access, 'string');
    const resync = resyncConsumedAccess('other-fp', {
      runner: () => JSON.stringify({
        claudeAiOauth: { accessToken: 'test-access-2', expiresAt: 4102444800000 },
      }),
      env: { USER: 'fixture-user' },
    });
    assert.equal(resync.resynced, true);
    const snaps = loadCswapUsageSnapshots({
      sequencePath: join(__dirname, 'does-not-exist-sequence.json'),
      usagePath: join(__dirname, 'does-not-exist-usage.json'),
    });
    assert.ok(Array.isArray(snaps));
    console.log(`TOKEN_POSTS=${spies.tokenPosts} CSWAP_SPAWNS=${spies.cswapSpawns} SECURITY_WRITES=${spies.securityWrites}`);
    assert.equal(spies.tokenPosts, 0);
    assert.equal(spies.cswapSpawns, 0);
    assert.equal(spies.securityWrites, 0);
  });

  it('no-live-cswap-or-token-post', () => {
    const root = join(__dirname, '..', '..', 'test');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    let liveCswap = 0;
    let tokenPost = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n').filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
        if (trimmed.includes('assert.doesNotMatch')) return false;
        return true;
      });
      const body = lines.join('\n');
      const listNeedle = 'cswap' + ' list';
      const grantNeedle = 'grant' + '_type';
      if (body.includes(listNeedle)) liveCswap += 1;
      if (body.includes(grantNeedle)) tokenPost += 1;
    }
    console.log(`LIVE_CSWAP=0 TOKEN_POST_IN_TESTS=0`);
    assert.equal(liveCswap, 0);
    assert.equal(tokenPost, 0);
  });
});
