import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAUDE_CODE_SYSTEM_PREFIX,
  claudeCodeIdentityHeaders,
  claudeCodeVersion,
  ensureClaudeCodeSystemPrefix,
} from '../src/claude-code-identity';

describe('claude-code-identity', () => {
  it('version is semver-shaped (CLI or fallback)', () => {
    assert.match(claudeCodeVersion(), /^\d+\.\d+\.\d+/);
  });

  it('headers: adds OAuth betas, UA and x-app for a bare client', () => {
    const h = claudeCodeIdentityHeaders({});
    assert.equal(h['anthropic-beta'], 'oauth-2025-04-20,claude-code-20250219');
    assert.match(h['user-agent'], /^claude-code\/\d+\.\d+\.\d+ \(external, cli\)$/);
    assert.equal(h['x-app'], 'cli');
  });

  it('headers: unions client betas, dedupes, keeps a Claude Code UA', () => {
    const h = claudeCodeIdentityHeaders({
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14, oauth-2025-04-20',
      'user-agent': 'claude-code/9.9.9 (external, cli)',
      'x-app': 'cli',
    });
    assert.equal(
      h['anthropic-beta'],
      'fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20,claude-code-20250219',
    );
    assert.equal(h['user-agent'], undefined);
    assert.equal(h['x-app'], undefined);
  });

  it('system: string → [prefix, string]; missing → [prefix]; list → prepended', () => {
    const a: Record<string, unknown> = { system: 'hi' };
    assert.equal(ensureClaudeCodeSystemPrefix(a), true);
    assert.deepEqual(a.system, [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX },
      { type: 'text', text: 'hi' },
    ]);
    const b: Record<string, unknown> = {};
    assert.equal(ensureClaudeCodeSystemPrefix(b), true);
    assert.deepEqual(b.system, [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }]);
    const c: Record<string, unknown> = { system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] };
    assert.equal(ensureClaudeCodeSystemPrefix(c), true);
    assert.equal((c.system as Array<{ text: string }>)[0].text, CLAUDE_CODE_SYSTEM_PREFIX);
    assert.equal((c.system as Array<{ text: string }>)[1].text, 'x');
  });

  it('system: idempotent when the prefix is already present', () => {
    const s = `${CLAUDE_CODE_SYSTEM_PREFIX}\n\nmore`;
    const a: Record<string, unknown> = { system: s };
    assert.equal(ensureClaudeCodeSystemPrefix(a), false);
    assert.equal(a.system, s);
    const list = [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }, { type: 'text', text: 'y' }];
    const b: Record<string, unknown> = { system: list };
    assert.equal(ensureClaudeCodeSystemPrefix(b), false);
    assert.equal(b.system, list);
  });
});
