import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { redactError, redactEvent, redactJson, redactKeyValueText, redactSecrets } from '../src/redact';
import {
  AC41_BODY, AC41_FIXTURES, leakedFixtures, runAutoThrownTick, runDoctorClaudeActive, runDoctorJournalInProgress, runDoctorSwitchJournal,
  runDoctorUndoIncomplete, runDoctorUndoLineage, runDoctorUnpersistedToken, runPoll4xx, runReportCutover, runStatusHistory, runSwitchStep7,
  AC41_STASH_ID, runDoctorAutoParked, runDoctorLoginExpiry, runDoctorStrayTemps, runDoctorUnclaimed, runDoctorVersionDrift,
  runAutoResumeDrillBegin, runImportReconcile, runJournalResolve, runLifecycleDrillDone, runSentinelsRecord, runSwitchJournalFields,
  runUndoRecordDrill,
  type DoctorArtifacts,
} from './ac41-writer-scenarios';

const REDACTED = '[redacted]';

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const sk = 'sk-' + 'ant-' + 'a'.repeat(40);
const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(24) + '.' + 'c'.repeat(24);
const unsignedJwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(24) + '.';

function bearer(last: string): string {
  return 'Bearer ' + 'a'.repeat(24) + last;
}

describe('redaction', () => {
  it('redacts key-value diagnostic text without treating safe key prefixes as credentials', () => {
    const result = redactKeyValueText(`PASSWORD=hunter2\nAuthorization: Basic abc123\ncookie=session=xyz\n"refresh-token":"value"\n'client_secret': 'value'\npasswordless=keep token_count=5`, []);

    for (const secret of ['hunter2', 'Basic abc123', 'session=xyz', 'value']) assert.equal(result.includes(secret), false);
    assert.match(result, /passwordless=keep/);
    assert.match(result, /token_count=5/);
  });

  it('fails closed from a sensitive key through the end of its diagnostic line', () => {
    const cases = [
      ['stderr: password=hunter2 rest', 'stderr: password=[redacted]'],
      ['Cookie: session=abc; csrf=def', 'Cookie: [redacted]'],
      ['msg: api_key=abc; ok', 'msg: api_key=[redacted]'],
      ['password="hunter 2"', 'password=[redacted]'],
      ['token_ = hunter2', 'token_ = [redacted]'],
      ['api-key- : value', 'api-key- : [redacted]'],
      ['password=\nhunter2', 'password=\n[redacted]'],
      ['api-key- :\n value', 'api-key- :\n [redacted]'],
      ['token_count=5', 'token_count=5'],
      ['passwordless login', 'passwordless login'],
    ] as const;

    for (const [input, expected] of cases) assert.equal(redactKeyValueText(input, []), expected);
  });

  it('redacts a sensitive key PEM value through its matching end line', () => {
    const input = 'private_key:\n-----BEGIN PRIVATE KEY-----\nfixture-pem-body\n-----END PRIVATE KEY-----\nkind: safe';

    const result = redactKeyValueText(input, []);

    assert.equal(result, 'private_key:\n[redacted]\nkind: safe');
    assert.equal(result.includes('fixture-pem-body'), false);
  });

  it('redacts a sensitive key PEM value with CRLF line endings', () => {
    const input = 'private_key:\r\n-----BEGIN PRIVATE KEY-----\r\nfixture-pem-body\r\n-----END PRIVATE KEY-----\r\nkind: safe';

    const result = redactKeyValueText(input, []);

    assert.equal(result, 'private_key:\r\n[redacted]\r\nkind: safe');
    assert.equal(result.includes('fixture-pem-body'), false);
  });

  it('redacts PEM blocks without a sensitive key', () => {
    const input = 'before\n-----BEGIN CERTIFICATE-----\nfixture-pem-body\n-----END CERTIFICATE-----\nafter';

    const result = redactKeyValueText(input, []);

    assert.equal(result, 'before\n[redacted]\nafter');
    assert.equal(result.includes('fixture-pem-body'), false);
  });

  it('redacts an unterminated PEM block through the end of text', () => {
    const input = 'before\n-----BEGIN PRIVATE KEY-----\nfixture-pem-body';

    assert.equal(redactKeyValueText(input, []), 'before\n[redacted]');
  });

  it('redacts YAML block scalar values for sensitive keys', () => {
    const input = 'password: |\n  fixture-secret\n  continued-fixture\nkind: safe';

    const result = redactKeyValueText(input, []);

    assert.equal(result, 'password: [redacted]\nkind: safe');
    assert.equal(result.includes('fixture-secret'), false);
  });

  it('leaves an unrelated following key unchanged after a multiline sensitive value', () => {
    const input = 'token: >\n  fixture-secret\nkind: safe';

    assert.equal(redactKeyValueText(input, []), 'token: [redacted]\nkind: safe');
  });

  it('redacts block scalars for sensitive prefixed and dotted keys', () => {
    const cases = [
      ['db_password: |\n  fixture-secret\nkind: safe', 'db_password: [redacted]\nkind: safe'],
      ['spring.datasource.password: >\n  fixture-secret\nkind: safe', 'spring.datasource.password: [redacted]\nkind: safe'],
      ['"password": |\n  fixture-secret\nkind: safe', '"password": [redacted]\nkind: safe'],
    ] as const;

    for (const [input, expected] of cases) {
      const result = redactKeyValueText(input, []);
      assert.equal(result.includes('fixture-secret'), false);
      assert.equal(fingerprint(result), fingerprint(expected));
    }
  });

  it('redacts block scalars for sensitive YAML sequence-item keys', () => {
    const input = '- password: |\n    fixture-secret\n- kind: safe';
    const expected = '- password: [redacted]\n- kind: safe';
    const result = redactKeyValueText(input, []);

    assert.equal(result.includes('fixture-secret'), false);
    assert.equal(fingerprint(result), fingerprint(expected));
  });

  it('redacts indented continuation lines for sensitive YAML sequence-item keys', () => {
    const input = '- password:\n    first-fixture\n    second-fixture\n- kind: safe';
    const expected = '- password:\n    [redacted]\n- kind: safe';
    const result = redactKeyValueText(input, []);

    assert.equal(result.includes('first-fixture'), false);
    assert.equal(result.includes('second-fixture'), false);
    assert.equal(fingerprint(result), fingerprint(expected));
  });

  it('leaves non-sensitive YAML blocks unchanged', () => {
    const input = 'kind: |\n  safe block\nnext: safe';

    assert.equal(fingerprint(redactKeyValueText(input, [])), fingerprint(input));
  });

  it('redacts supplied secrets and their SHA-256 fingerprints', () => {
    const secret = 'fixture-' + 'secret-value';
    const result = redactSecrets(`token=${secret} fingerprint=${fingerprint(secret)}`, [secret]);

    assert.equal(result.includes(secret), false);
    assert.equal(result.includes(fingerprint(secret)), false);
    assert.equal(result, `token=${REDACTED} fingerprint=${REDACTED}`);
  });

  it('redacts longest supplied values before their prefixes and their fingerprints', () => {
    const prefix = 'prefix-';
    const full = prefix + 'value-' + 'a'.repeat(24);
    const result = redactSecrets(`${prefix} ${full} ${fingerprint(full)}`, [prefix, full]);

    assert.equal(result.includes(prefix), false);
    assert.equal(result.includes(full), false);
    assert.equal(result.includes(fingerprint(full)), false);
    assert.equal((result.match(/\[redacted\]/g) ?? []).length, 3);
  });

  it('redacts token-shaped values in a 2 KB body without requiring their values (AC41 2 KB body)', () => {
    const bodyTokens = [sk, 'sk-' + 'or-v1-' + 'b'.repeat(40), jwt];
    const body = `${'x'.repeat(1800)} ${bodyTokens.join(' ')} ${'y'.repeat(180)} `;
    assert.ok(Buffer.byteLength(body) >= 2048);

    const result = redactSecrets(body, []);
    for (const token of bodyTokens) assert.equal(result.includes(token), false);
    assert.equal((result.match(/\[redacted\]/g) ?? []).length, 3);
  });

  it('redacts unsigned JWTs with an empty signature segment', () => {
    const result = redactSecrets(`token=${unsignedJwt}`, []);

    assert.equal(result.includes(unsignedJwt), false);
    assert.equal(result, `token=${REDACTED}`);
  });

  it('redacts xAI keys and tokens ending in every supported punctuation character', () => {
    const xai = 'xai-' + 'A'.repeat(40);
    const values = [sk + '-', 'key_' + sk + '-', jwt + '-', ...['~', '-', '.', '+', '/', '='].map(bearer), xai];

    const result = redactSecrets(values.join(' '), []);
    for (const value of values) assert.equal(result.includes(value), false, value.slice(0, 8));
    assert.equal((result.match(/\[redacted\]/g) ?? []).length, values.length);
  });

  it('redacts stream events by pattern even with no supplied secret', () => {
    const event = { error: `${sk}-` };
    const result = JSON.stringify(redactEvent(event, []));

    assert.equal(result.includes(sk), false);
  });

  it('preserves live event keys and primitive value types while redacting string values', () => {
    const raw = 'raw-secret-value';
    const event = {
      usage: { tokens: 12, total_tokens: 3, cached: false, empty: null },
      toolCall: { arguments: { token: 'abc', password: 'p', apiKey: 'k', cookie: 'c' } },
      raw,
      content: sk,
    };

    const result = redactEvent(event, [raw]) as typeof event;
    assert.deepEqual(result.usage, { tokens: 12, total_tokens: 3, cached: false, empty: null });
    assert.deepEqual(result.toolCall.arguments, { token: 'abc', password: 'p', apiKey: 'k', cookie: 'c' });
    assert.equal(result.raw, REDACTED);
    assert.equal(result.content, REDACTED);
  });

  it('redacts persisted property names and preserves collisions without dropping values', () => {
    const secret = 'fixture-' + 'secret-key';
    const tokenKey = 'sk-' + 'key-' + 'k'.repeat(40);
    const result = redactJson({ [secret]: 1, [tokenKey]: 2 }, [secret]);
    const parsed = JSON.parse(result) as Record<string, number>;

    assert.equal(result.includes(secret), false);
    assert.equal(result.includes(tokenKey), false);
    assert.deepEqual(parsed, { [REDACTED]: 1, [`${REDACTED}#2`]: 2 });
  });

  it('preserves own __proto__ fields without changing the clone prototype', () => {
    const input = JSON.parse('{"__proto__":{"type":"error"},"type":"ok"}') as Record<string, unknown>;
    const parsed = JSON.parse(redactJson(input, [])) as Record<string, unknown>;

    assert.equal(Object.hasOwn(parsed, '__proto__'), true);
    assert.deepEqual(parsed.__proto__, { type: 'error' });
    assert.equal(parsed.type, 'ok');
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  });

  it('redacts sensitive key variants case-insensitively without invoking accessors or get traps', () => {
    const secret = 'opaque-' + 'value';
    const input = {
      token: secret,
      accessToken: secret,
      refresh_token: secret,
      'id-token': secret,
      apiKey: secret,
      api_key: secret,
      secret,
      clientSecret: secret,
      password: secret,
      authorization: secret,
      cookie: secret,
      'set-cookie': secret,
      'x-api-key': secret,
      get getter() {
        throw new Error('must not run');
      },
      get returnedSecret() {
        return secret;
      },
    };
    const guarded = new Proxy({ token: secret }, {
      get() {
        throw new Error('must not run');
      },
    });

    const parsed = JSON.parse(redactJson({ input, guarded }, [])) as Record<string, unknown>;
    assert.deepEqual(parsed.input, {
      token: REDACTED,
      accessToken: REDACTED,
      refresh_token: REDACTED,
      'id-token': REDACTED,
      apiKey: REDACTED,
      api_key: REDACTED,
      secret: REDACTED,
      clientSecret: REDACTED,
      password: REDACTED,
      authorization: REDACTED,
      cookie: REDACTED,
      'set-cookie': REDACTED,
      'x-api-key': REDACTED,
      getter: REDACTED,
      returnedSecret: REDACTED,
    });
    assert.deepEqual(parsed.guarded, { token: REDACTED });
    assert.equal(redactError({ token: secret }, []), '{"token":"[redacted]"}');
  });

  it('memoizes shared DAG clones while marking true cycles', () => {
    let node: Record<string, unknown> = { value: 'leaf' };
    for (let index = 0; index < 40; index += 1) node = { a: node, b: node };

    const started = Date.now();
    const clone = redactEvent(node, []) as Record<string, unknown>;
    assert.ok(Date.now() - started < 1_000, '40-level DAG must not expand per path');
    let cursor = clone;
    for (let index = 0; index < 40; index += 1) {
      assert.strictEqual(cursor.a, cursor.b, `level ${index} must reuse its shared clone`);
      cursor = cursor.a as Record<string, unknown>;
    }
  });

  it('drops functions including toJSON and copies shared values while marking true cycles', () => {
    const secret = 'fixture-' + 'secret-value';
    const shared = { value: `safe ${secret}` };
    const input: Record<string, unknown> = {
      a: shared,
      b: shared,
      callback() {
        return secret;
      },
      toJSON() {
        return secret;
      },
    };
    input.self = input;

    const result = redactJson(input, [secret]);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    assert.equal(result.includes(secret), false);
    assert.deepEqual(parsed.a, { value: `safe ${REDACTED}` });
    assert.deepEqual(parsed.b, { value: `safe ${REDACTED}` });
    assert.equal(parsed.self, '[circular]');
    assert.equal('callback' in parsed, false);
    assert.equal('toJSON' in parsed, false);
  });

  it('handles unreadable and primitive Error message descriptors without throwing', () => {
    const unreadable = new Error('ignored');
    Object.defineProperty(unreadable, 'message', { get() { throw new Error('must not run'); } });
    const numeric = new Error('ignored');
    Object.defineProperty(numeric, 'message', { value: 42 });

    assert.equal(redactError(unreadable, []), '[unreadable]');
    assert.equal(redactError(numeric, []), '42');
  });

  it('redacts Error messages and emits a single escaped line', () => {
    const secret = 'sk-' + 'ant-' + 'z'.repeat(40);
    const error = redactError(new Error(`request\nfailed\r${secret}\u0007`), [secret]);

    assert.equal(error.includes(secret), false);
    assert.equal(error.includes('\n'), false);
    assert.equal(error.includes('\r'), false);
    assert.equal(error.includes('\u0007'), false);
    assert.match(error, /request\\nfailed\\r\[redacted\]\\u0007/);
  });
});

// AC41 (HP-H3-12). Each subtest runs one real writer with the synthetic
// failure body and inspects what that writer actually persisted or printed.
// "redaction proof" rows fail if the named writer boundary stops redacting;
// "non-propagation control" rows assert the writer's fixed artifact and do
// not claim a redactor ran. Later slices add the remaining writers here.
describe('AC41 writer sweep', () => {
  it('uses the three synthetic fixtures in a body of at least 2 KB', () => {
    assert.equal(AC41_FIXTURES.length, 3);
    assert.ok(Buffer.byteLength(AC41_BODY) >= 2_048);
    for (const fixture of AC41_FIXTURES) assert.ok(AC41_BODY.includes(fixture));
  });

  it('sweep: no fixture secret survives in any writer', async (t) => {
    // Every inventory row runs as one named subtest; the parent checks at the end
    // that all 23 AC41 inventory rows ran (HP-H3-12D completeness).
    const covered: number[] = [];
    const sweepRow = async (title: string, fn: () => Promise<void>): Promise<void> => {
      covered.push(Number(/^row (\d+) /.exec(title)?.[1]));
      await t.test(title, fn);
    };

    await sweepRow('row 1 Claude switch step-7 failure: switch_log.error and steps_json (non-propagation control)', async () => {
      const artifacts = await runSwitchStep7();
      assert.equal(artifacts.thrown, 'true');
      assert.equal(artifacts.outcome, 'rolled-back');
      assert.equal(artifacts.error, 'keychain-write-failed');
      assert.equal(artifacts.detail, 'step-7');
      assert.equal((JSON.parse(artifacts.stepsJson ?? '{}') as { failedStep?: number }).failedStep, 7);
      for (const key of ['error', 'detail', 'stepsJson']) assert.deepEqual(leakedFixtures(artifacts[key]), [], key);
    });

    await sweepRow('row 2 Anthropic poll 4xx: usage_polls.last_status (non-propagation control)', async () => {
      const artifacts = await runPoll4xx();
      assert.equal(artifacts.bodyServed, 'true');
      assert.equal(artifacts.lastStatus, 'http-403');
      assert.deepEqual(leakedFixtures(artifacts.lastStatus), []);
    });

    // Two stacked boundaries guard this line (the tick's redactError and the
    // loop's redactedLog); the proof fails only when both are bypassed.
    await sweepRow('row 14 auto thrown tick: auto log line (redaction proof)', async () => {
      const { log } = await runAutoThrownTick();
      assert.match(log ?? '', /^auto: tick error: ac41-failure-pad /);
      assert.deepEqual(leakedFixtures(log), []);
    });

    // Two stacked boundaries: the report's pre-serialization redactJson and
    // runExecutingCommand's output redaction. The five-family control-character
    // regression in report-cutover.test.ts separately pins the redactJson boundary.
    await sweepRow('row 16 report cutover: text and --json output (redaction proof)', async () => {
      const artifacts = await runReportCutover();
      assert.ok(JSON.parse((artifacts.json ?? '').split('\n')[0] ?? 'null'));
      assert.match(artifacts.json ?? '', /ac41-failure-pad/);
      assert.match(artifacts.text ?? '', /ac41-failure-pad/);
      for (const key of ['json', 'text']) assert.deepEqual(leakedFixtures(artifacts[key]), [], key);
    });

    // Stored rows prove the write boundary; command output proves write and read boundaries together.
    await sweepRow('row 17 status switches, relogins and AC33 JSON (redaction proof)', async () => {
      const artifacts = await runStatusHistory();
      assert.match(artifacts.storedSwitchError ?? '', /ac41-failure-pad/);
      assert.match(artifacts.storedUsageStatus ?? '', /ac41-failure-pad/);
      assert.match(artifacts.storedReloginDetail ?? '', /^sha256:[0-9a-f]{16}$/);
      assert.equal((JSON.parse(artifacts.switchesJson ?? '{}') as { switches: unknown[] }).switches.length, 1);
      assert.equal((JSON.parse(artifacts.reloginsJson ?? '{}') as { relogins: unknown[] }).relogins.length, 1);
      assert.match(artifacts.statusJson ?? '', /ac41-failure-pad/);
      for (const [key, value] of Object.entries(artifacts)) assert.deepEqual(leakedFixtures(value), [], key);
    });

    // Doctor rows (HP-H3-12B). Each runs the real `qlb doctor` CLI for text and
    // --json and reads the newest health_log.failing_json. Text and JSON pass the
    // doctor report boundary (redactCheck); S64-blocking rows are written to
    // history behind a second boundary (appendHealthLog's redactJson), so a
    // history proof fails only when both are bypassed.
    const assertDoctorClean = (artifacts: DoctorArtifacts, name: string): void => {
      assert.match(artifacts.text, new RegExp(`\\] ${name}: `));
      for (const key of ['message', 'text', 'json', 'history'] as const) assert.deepEqual(leakedFixtures(artifacts[key]), [], key);
    };

    await sweepRow('row 4 doctor claude:switch-journal: text/JSON and failing_json (redaction proof)', async () => {
      const artifacts = await runDoctorSwitchJournal();
      assert.equal(artifacts.level, 'FAIL');
      assert.match(artifacts.message ?? '', /^unfinished Claude switch journal .*attemptId=ac41-attempt step=7 from=.*ac41-failure-pad.* to=.*ac41-failure-pad.*; run qlb claude journal resolve --forward or qlb claude journal resolve --back$/);
      assert.equal(artifacts.historyHasRow, true);
      assertDoctorClean(artifacts, 'claude:switch-journal');
    });

    await sweepRow('row 5 doctor journal:in-progress: text/JSON (redaction proof); INFO row absent from failing_json (control)', async () => {
      const artifacts = await runDoctorJournalInProgress();
      assert.equal(artifacts.level, 'INFO');
      assert.match(artifacts.message ?? '', /^C-swap import lock is fresh; phases=\[redacted\]:invalid, \[redacted\]:invalid, \[redacted\]:invalid$/);
      assert.equal(artifacts.historyHasRow, false);
      assertDoctorClean(artifacts, 'journal:in-progress');
    });

    await sweepRow('row 6 doctor undo:incomplete: fixed text/JSON and failing_json (non-propagation control)', async () => {
      const artifacts = await runDoctorUndoIncomplete();
      assert.equal(artifacts.level, 'FAIL');
      assert.equal(artifacts.message, 'undo-unfinished: undo_began_at=1234; run qlb undo cswap --resume');
      assert.equal(artifacts.historyHasRow, true);
      assertDoctorClean(artifacts, 'undo:incomplete');
    });

    await sweepRow('row 7 doctor undo:lineage-match: fixed text/JSON and failing_json (non-propagation control)', async () => {
      const artifacts = await runDoctorUndoLineage();
      assert.equal(artifacts.level, 'FAIL');
      assert.equal(artifacts.message, 'refused: active-slot-missing');
      assert.equal(artifacts.historyHasRow, true);
      assertDoctorClean(artifacts, 'undo:lineage-match');
    });

    await sweepRow('row 8 doctor claude:active: fixed text/JSON and failing_json (non-propagation control)', async () => {
      const artifacts = await runDoctorClaudeActive();
      assert.equal(artifacts.level, 'FAIL');
      assert.equal(artifacts.message, 'active Claude login names a dead or archived slot');
      assert.equal(artifacts.historyHasRow, true);
      assertDoctorClean(artifacts, 'claude:active');
    });

    await sweepRow('row 11 doctor claude:unpersisted-token: text/JSON and failing_json (redaction proof)', async () => {
      const artifacts = await runDoctorUnpersistedToken();
      assert.equal(artifacts.level, 'FAIL');
      assert.match(artifacts.message ?? '', /^unpersisted Claude token evidence without later recovery: ac41-failure-pad .*; re-login affected slot\(s\)$/);
      assert.equal(artifacts.historyHasRow, true);
      assertDoctorClean(artifacts, 'claude:unpersisted-token');
    });

    // Doctor advisory rows (HP-H3-12C). Rows 3, 9, 10 and 12 are non-propagation
    // controls: the AC41 body sits at the row's real input but the check normalizes
    // or never reads it, so they assert the fixed artifact and zero forwarding and
    // do not claim a redactor ran. Row 13 differs: the body does reach its message,
    // behind two stacked redaction boundaries. All five rows are advisory (WARN
    // outside the S64 blocking list, or claude:login-expiry, which S64 always
    // excludes), so their history assertion is exact absence from failing_json.
    await sweepRow('row 3 doctor auto:parked: fixed text/JSON; absent from failing_json (non-propagation control)', async () => {
      const artifacts = await runDoctorAutoParked();
      assert.equal(artifacts.level, 'WARN');
      assert.equal(artifacts.message, 'parked marker unreadable');
      assert.equal(artifacts.historyHasRow, false);
      assertDoctorClean(artifacts, 'auto:parked');
    });

    await sweepRow('row 9 doctor claude:login-expiry: fixed text/JSON; absent from failing_json (non-propagation control)', async () => {
      const artifacts = await runDoctorLoginExpiry();
      assert.equal(artifacts.level, 'WARN');
      assert.equal(artifacts.message, 'Claude credential unreadable for slot ac41-slot');
      assert.equal(artifacts.historyHasRow, false);
      assertDoctorClean(artifacts, 'claude:login-expiry');
    });

    await sweepRow('row 10 doctor claude:unclaimed: fixed text/JSON; absent from failing_json (non-propagation control)', async () => {
      const artifacts = await runDoctorUnclaimed();
      assert.equal(artifacts.level, 'WARN');
      assert.equal(artifacts.message, `1 unclaimed Claude stash(es) older than 30 days: qlb claude restore-unclaimed ${AC41_STASH_ID} ac41-slot`);
      assert.equal(artifacts.historyHasRow, false);
      assertDoctorClean(artifacts, 'claude:unclaimed');
    });

    await sweepRow('row 12 doctor fs:stray-temps: path-only text/JSON; absent from failing_json (non-propagation control)', async () => {
      const artifacts = await runDoctorStrayTemps();
      assert.equal(artifacts.level, 'WARN');
      assert.match(artifacts.message ?? '', /^1 stray temporary file found: \/.*\/\.qlb-ac41\.999999999\.aaaaaaaaaaaaaaaa\.tmp$/);
      assert.equal(artifacts.historyHasRow, false);
      assertDoctorClean(artifacts, 'fs:stray-temps');
    });

    await sweepRow('row 13 doctor claude:version-drift: text/JSON (stacked redaction proof); absent from failing_json', async () => {
      // The probe output reaches the message, guarded by two stacked boundaries:
      // readClaudeVersion's redaction, then the doctor report boundary. The proof
      // fails only when both are bypassed.
      const artifacts = await runDoctorVersionDrift();
      assert.equal(artifacts.level, 'WARN');
      assert.match(artifacts.message ?? '', /^Claude Code version drift: recorded Claude Code 1\.0\.0; installed ac41-failure-pad /);
      assert.equal(artifacts.historyHasRow, false);
      assertDoctorClean(artifacts, 'claude:version-drift');
    });

    // Remaining writers (HP-H3-12D). Commands run through their real entrypoints
    // against isolated test-mode stores.
    const assertClean = (artifacts: Record<string, string | null>): void => {
      for (const [key, value] of Object.entries(artifacts)) assert.deepEqual(leakedFixtures(value), [], key);
    };

    await sweepRow('row 15 Claude switch journal error, steps and detail (non-propagation control; configText excluded)', async () => {
      // The v1 journal has no error or steps field and the switch never copies a
      // thrown body into it. configText is verbatim rollback material and is
      // deliberately left out of this assertion.
      const artifacts = await runSwitchJournalFields();
      assert.notEqual(artifacts.journal, null);
      assert.equal(artifacts.detail, null);
      const keys = (artifacts.keys ?? '').split(',');
      assert.equal(keys.includes('error'), false);
      assert.equal(keys.includes('steps'), false);
      assert.equal(keys.includes('configText'), false);
      assertClean(artifacts);
    });

    await sweepRow('row 18 auto resume and drill-begin output (non-propagation control)', async () => {
      const artifacts = await runAutoResumeDrillBegin();
      assert.equal(artifacts.resumeTextCode, '0');
      assert.equal(artifacts.resumeTextStdout, 'cleared-invalid');
      assert.deepEqual(JSON.parse(artifacts.resumeJsonStdout ?? ''), { provider: 'anthropic', resumed: 'cleared-invalid', suspendedUntil: null });
      assert.equal(artifacts.drillTextCode, '0');
      assert.equal(artifacts.drillTextStdout, 'auto drill began');
      assert.equal(artifacts.storedMarker, '');
      assert.equal(artifacts.storedDrillBeganAt, '30');
      assertClean(artifacts);
    });

    await sweepRow('row 19 lifecycle drill-done refusal (non-propagation control)', async () => {
      const artifacts = await runLifecycleDrillDone();
      assert.equal(artifacts.textCode, '3');
      assert.equal(artifacts.textStderr, 'lifecycle drill refused: drill-rows-missing: usage-5xx,fail-step-8,breaker-rows,undo-dry-run');
      const json = JSON.parse(artifacts.jsonStdout ?? '') as { ok: boolean; code: string; missing: string[] };
      assert.deepEqual({ ok: json.ok, code: json.code, missing: json.missing }, { ok: false, code: 'drill-rows-missing', missing: ['usage-5xx', 'fail-step-8', 'breaker-rows', 'undo-dry-run'] });
      assertClean(artifacts);
    });

    await sweepRow('row 20 undo C-swap --dry-run --record-drill output (redaction proof)', async () => {
      const artifacts = await runUndoRecordDrill();
      assert.equal(artifacts.textCode, '0');
      assert.match(artifacts.textStdout ?? '', /^activeAccountNumber=1\nslot 1: update claude-swap\/account-1-ac41-failure-pad /);
      const json = JSON.parse(artifacts.jsonStdout ?? '') as { activeAccountNumber: number; dryRun: boolean; slots: Array<{ item: string }> };
      assert.equal(json.activeAccountNumber, 1);
      assert.equal(json.dryRun, true);
      assert.equal(json.slots.length, 1);
      assert.match(json.slots[0]?.item ?? '', /^account-1-ac41-failure-pad /);
      assert.equal(artifacts.storedDryRunAt, '123');
      assertClean(artifacts);
    });

    await sweepRow('row 21 Claude journal rollback output and switch_log row (non-propagation control)', async () => {
      const artifacts = await runJournalResolve();
      assert.equal(artifacts.backCode, '0');
      assert.equal(artifacts.backStdout, 'Claude journal resolved back');
      assert.deepEqual(JSON.parse(artifacts.switchRows ?? ''), [{ from_account: 'ac41-from-slot', to_account: 'ac41-to-slot', detail: 'journal-back', error: null, steps_json: JSON.stringify({ attempt: 'ac41-attempt' }) }]);
      assertClean(artifacts);
    });

    await sweepRow('row 22 C-swap import --reconcile text and --json (non-propagation control)', async () => {
      const artifacts = await runImportReconcile();
      for (const mode of ['text', 'json']) {
        assert.equal(artifacts[`${mode}Code`], '3');
        assert.equal(artifacts[`${mode}Stderr`], 'import cswap refused: import-journal-unclassifiable ac41-run');
      }
      assertClean(artifacts);
    });

    await sweepRow('row 23 lifecycle sentinels record output and stored sentinel (redaction proof)', async () => {
      const artifacts = await runSentinelsRecord();
      assert.equal(artifacts.textCode, '0');
      assert.match(artifacts.textStderr ?? '', /^lifecycle sentinel recorded: ac41-failure-pad /);
      assert.match(artifacts.storedVersion ?? '', /^ac41-failure-pad /);
      assert.equal((JSON.parse(artifacts.jsonStdout ?? '') as { claudeCodeVersion: string }).claudeCodeVersion, artifacts.storedVersion);
      assertClean(artifacts);
    });

    assert.deepEqual([...covered].sort((left, right) => left - right), Array.from({ length: 23 }, (_, index) => index + 1));
  });
});
