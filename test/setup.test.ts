import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  QLB_ADVISORY_FUNCTION,
  isSetupHarness,
  setupHarness,
} from '../src/setup';

describe('qlb setup helpers', () => {
  it('accepts the four documented harnesses and rejects others', () => {
    assert.equal(isSetupHarness('pi'), true);
    assert.equal(isSetupHarness('claude-code'), true);
    assert.equal(isSetupHarness('codex-cli'), true);
    assert.equal(isSetupHarness('generic'), true);
    assert.equal(isSetupHarness('hermes'), false);
  });

  it('writes the verbatim qlb_advisory function for pi', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-setup-pi-'));
    const result = setupHarness('pi', { repoRoot: root });
    assert.equal(result.harness, 'pi');
    assert.equal(result.snippetWritten, 'scripts/hooks/pi-advisory.sh');
    assert.match(result.instructions, /qlb_advisory/);
    const written = readFileSync(join(root, 'scripts/hooks/pi-advisory.sh'), 'utf8');
    assert.ok(written.includes(QLB_ADVISORY_FUNCTION));
    assert.match(written, /local model="\$\{1:-\}"/);
    assert.match(written, /qlb_cmd=\(qlb\)/);
  });

  it('describes Claude Code proxy env vars without writing files', () => {
    const result = setupHarness('claude-code', { repoRoot: null });
    assert.equal(result.snippetWritten, undefined);
    assert.match(result.instructions, /ANTHROPIC_BASE_URL=/);
    assert.match(result.instructions, /ANTHROPIC_AUTH_TOKEN=/);
    assert.match(result.instructions, /ANTHROPIC_API_KEY=/);
    assert.match(result.instructions, /Bearer/);
    assert.match(result.instructions, /x-api-key/);
    assert.match(result.instructions, /proxy\.json/);
    assert.match(result.instructions, /\/v1\/messages/);
  });

  it('describes Codex CLI /v1/responses model_provider snippet', () => {
    const result = setupHarness('codex-cli', { repoRoot: null });
    assert.equal(result.snippetWritten, undefined);
    assert.match(result.instructions, /\/v1\/responses/);
    assert.match(result.instructions, /\[model_providers\.qlb\]/);
    assert.match(result.instructions, /wire_api = "responses"/);
    assert.match(result.instructions, /QLB_PROXY_TOKEN/);
    assert.match(result.instructions, /backend-api\/codex\/responses/);
  });

  it('prints a harness-agnostic resolve --json + jq snippet', () => {
    const result = setupHarness('generic', { repoRoot: null });
    assert.equal(result.snippetWritten, undefined);
    assert.match(result.instructions, /qlb resolve --model/);
    assert.match(result.instructions, /--json/);
    assert.match(result.instructions, /jq/);
    assert.match(result.instructions, /ANY shell-based job runner/);
  });
});
