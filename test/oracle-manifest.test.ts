import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(__dirname, '..', '..');
const ORACLE = join(ROOT, 'test', 'oracle', 'claude-swap-v0.28.0');
const MANIFEST_PATH = join(ORACLE, 'MANIFEST.json');
const LICENSE = join(ROOT, 'third_party', 'claude-swap', 'LICENSE');
const GOLDENS = join(ROOT, 'test', 'oracle', 'goldens');

type Manifest = {
  upstream: string;
  tag: string;
  commit: string;
  files: Record<string, string>;
  test_def_counts: Record<string, number>;
  test_switcher_top_level_test_classes: string[];
};

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesBelow(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

describe('claude-swap v0.28.0 oracle provenance', () => {
  it('matches every vendored file to its pinned manifest hash', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
    assert.equal(manifest.upstream, 'https://github.com/realiti4/claude-swap');
    assert.equal(manifest.tag, 'v0.28.0');
    assert.equal(manifest.commit, '2b2d71c7aeb49e6bd25393509ceb05dbca7b0e10');
    assert.equal(Object.keys(manifest.files).length, 72);
    assert.deepEqual(
      Object.keys(manifest.files)
        .filter((path) => path.startsWith('test/oracle/claude-swap-v0.28.0/src/'))
        .sort(),
      [
        '__init__.py', 'claude_locks.py', 'credentials.py', 'exceptions.py', 'fsutil.py',
        'json_output.py', 'lines.py', 'locking.py', 'logging_config.py', 'macos_keychain.py',
        'models.py', 'oauth.py', 'pace.py', 'paths.py',
        'poll_policy.py', 'printer.py', 'process_detection.py', 'session.py', 'settings.py',
        'switcher.py', 'usage_store.py',
      ].map((name) => `test/oracle/claude-swap-v0.28.0/src/claude_swap/${name}`),
    );
    assert.equal(Object.keys(manifest.test_def_counts).length, 50);
    assert.equal(manifest.test_def_counts['tests/test_switcher.py'], 502);
    assert.deepEqual(
      manifest.test_switcher_top_level_test_classes,
      [
        'TestEmailValidation', 'TestFindAccountSlot', 'TestPlatformDetection', 'TestJsonOperations', 'TestGetCurrentAccount', 'TestGetClaudeConfigPathUtf8', 'TestAccountExists', 'TestResolveAccountIdentifier', 'TestAliasValidation', 'TestResolveByAlias', 'TestAliasCommand', 'TestDirectorySetup', 'TestAddAccountRefresh', 'TestGetNextAccountNumber', 'TestStatus', 'TestStatusCache', 'TestFetchAccountUsageSessionProfile', 'TestAdoptSessionCredential', 'TestLiveSessionGuardOnAnUnreadableRecord', 'TestListAccountsUsage', 'TestUsageFetchStamps', 'TestActiveAccountRefresh', 'TestPerformSwitchPostDisplay', 'TestSwitchToSelfSlotAndForce', 'TestAccountInfoOrgFields', 'TestAccountExistsCompositeKey', 'TestGetCurrentAccountOrgSupport', 'TestDeadTokenQuarantine', 'TestAddAccountOrgFields', 'TestResolveIdentifierAmbiguity', 'TestListAccountsOrgDisplay', 'TestBackwardCompatibility', 'TestUpgradeMigration', 'TestAddAccountSlot', 'TestPurgeLegacyCleanup', 'TestAddAccountFromToken', 'TestPurge', 'TestSwitchSkipsBrokenSlots', 'TestUsageAwareSwitch', 'TestClaudeCodeLockCooperation', 'TestMacosKeychainFallback', 'TestFormatUsageLines', 'TestProvenanceGuard', 'TestSelfSwitchProvenance', 'TestDuplicateAccountDetection', 'TestLockstepUsageDetection', 'TestStashAndRetentionStore', 'TestActiveRefreshProvenance', 'TestDirectActivationPreservation', 'TestSharedOAuthCredentialPreservation', 'TestUuidConflictClassification', 'TestStashStorageHardening', 'TestStashManifestConcurrentMutation', 'TestRemoveAccountPrunesMappings', 'TestSwitchRemoveGatesAcceptAlias', 'TestAddAccountAlias', 'TestDisableEnableAccount', 'TestDegradedReadProvenance', 'TestBackupReadTriState', 'TestEncPermissionDeniedIsUnreadable', 'TestBackupUnreadableDisplay', 'TestSwitchUnreadableBackup', 'TestConsumeGate', 'TestInactiveRefreshRoutesThroughGate', 'TestStrikeUnbindsInCollector', 'TestStoreResolutionParity', 'TestConsumeGateLockFailures', 'TestPermanentlyUnreadableStashRow', 'TestHealedStrikeUnblocksFetching', 'TestGateUltraReviewFixes', 'TestActiveSlotStrikeParity', 'TestUltraReviewCoverageGaps', 'TestUnreadableBackupIsNotAbsent', 'TestStashReaderUnreadableVsAbsent', 'TestSessionShellGuardCoversEveryMutator', 'TestPollPolicyInputsCarryTheWeeklyLine', 'TestSwitchTransactionRollback', 'TestSalvageCopyMode',
      ],
    );

    const actualFiles = [
      LICENSE,
      ...filesBelow(ORACLE).filter((path) => path !== MANIFEST_PATH),
    ].map((path) => relative(ROOT, path)).sort();
    assert.deepEqual(Object.keys(manifest.files).sort(), actualFiles);

    for (const [repoRelativePath, expectedHash] of Object.entries(manifest.files)) {
      assert.match(expectedHash, /^[a-f0-9]{64}$/);
      const path = join(ROOT, repoRelativePath);
      assert.ok(existsSync(path), `vendored file is missing: ${repoRelativePath}`);
      assert.equal(sha256(path), expectedHash, `sha256 mismatch: ${repoRelativePath}`);
    }
  });

  it('contains parseable JSON goldens only', () => {
    const goldenFiles = filesBelow(GOLDENS).filter((path) => path.endsWith('.json'));
    assert.ok(goldenFiles.length > 0, 'expected committed oracle goldens');
    for (const path of goldenFiles) {
      assert.ok(statSync(path).size > 0, `golden is empty: ${relative(ROOT, path)}`);
      assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')), relative(ROOT, path));
    }
  });
});
