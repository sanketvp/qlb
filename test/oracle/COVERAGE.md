# Claude-swap v0.28.0 coverage map

This map tracks the v0.28.0 upstream tests vendored at
`claude-swap-v0.28.0/tests/`. The complete upstream `src/claude_swap/` package
is vendored alongside them, so every `claude_swap.*` import has pinned source
material available. `pending` means the behavior is in scope for a future QLB
port. The explicit non-goals below are not port targets.

## Provenance verification

`npm test` checks that the committed manifest and goldens match the vendored
bytes; it does not contact or inspect an upstream repository. To verify those
bytes against the pinned upstream Git tree, explicitly run:

```sh
python3 -I -B scripts/oracle-manifest.py --verify-upstream /path/to/claude-swap-clone
```

The supplied clone is read only through Git commands; do not run its code.

## Golden difference from v0.26.0

Only `settings_defaults.json` changed: `autoswitch.weekly_threshold` is now
`null`. Upstream commit `0a5b692cc688a7a18a03413c875d5aba5d1d26a8`
added the optional `autoswitch.weeklyThreshold` setting and CLI flag.

## Upstream files

| Upstream file | Status |
| --- | --- |
| `__init__.py` | n/a (support file) |
| `conftest.py` | n/a (test fixture configuration) |
| `fixtures/sample_config.json` | n/a (test fixture) |
| `test_account_policy_cli.py` | pending |
| `test_account_policy_store.py` | pending |
| `test_account_policy_stray_standby_key.py` | pending |
| `test_account_policy_values.py` | pending |
| `test_add_account_identity.py` | pending |
| `test_api_key_accounts.py` | pending |
| `test_app_bundle.py` | n/a (non-goal: app bundle) |
| `test_appearance.py` | pending |
| `test_autoswitch.py` | pending |
| `test_autoswitch_account_threshold.py` | pending |
| `test_backup_read_pacing.py` | pending |
| `test_cache.py` | pending |
| `test_claude_locks.py` | pending |
| `test_cli.py` | pending |
| `test_colour_cache_isolation.py` | pending |
| `test_config_cli.py` | pending |
| `test_credentials.py` | pending |
| `test_fsutil.py` | ported: `fsutil.py:134-246` → `src/fsutil.ts`, `test/fsutil.test.ts` |
| `test_json_output.py` | pending |
| `test_launch_agent.py` | pending |
| `test_lines.py` | pending |
| `test_locking.py` | pending |
| `test_logging_config.py` | pending |
| `test_macos_keychain.py` | pending |
| `test_macos_keychain_contract.py` | pending |
| `test_mappings.py` | pending |
| `test_menubar.py` | n/a (non-goal: menubar) |
| `test_migrations.py` | pending |
| `test_move_accounts.py` | pending |
| `test_oauth.py` | pending |
| `test_pace.py` | pending |
| `test_paths.py` | pending |
| `test_poll_policy.py` | pending |
| `test_printer.py` | pending |
| `test_process_detection.py` | pending |
| `test_real_store_guard.py` | pending |
| `test_session.py` | n/a (non-goal: session-run) |
| `test_settings.py` | pending |
| `test_swap_accounts.py` | pending |
| `test_switcher.py` | pending |
| `test_theme.py` | pending |
| `test_transfer.py` | n/a (non-goal: transfer) |
| `test_tui.py` | n/a (non-goal: TUI) |
| `test_tui_policy_display.py` | n/a (non-goal: TUI) |
| `test_update_check.py` | n/a (non-goal: update check) |
| `test_usage_store.py` | pending |
| `test_worker_gc_freeze.py` | pending |

## `test_switcher.py` top-level test classes

| Upstream class | Status |
| --- | --- |
| `test_switcher.py::TestEmailValidation` | pending |
| `test_switcher.py::TestFindAccountSlot` | pending |
| `test_switcher.py::TestPlatformDetection` | pending |
| `test_switcher.py::TestJsonOperations` | pending |
| `test_switcher.py::TestGetCurrentAccount` | pending |
| `test_switcher.py::TestGetClaudeConfigPathUtf8` | pending |
| `test_switcher.py::TestAccountExists` | pending |
| `test_switcher.py::TestResolveAccountIdentifier` | pending |
| `test_switcher.py::TestAliasValidation` | pending |
| `test_switcher.py::TestResolveByAlias` | pending |
| `test_switcher.py::TestAliasCommand` | pending |
| `test_switcher.py::TestDirectorySetup` | pending |
| `test_switcher.py::TestAddAccountRefresh` | pending |
| `test_switcher.py::TestGetNextAccountNumber` | pending |
| `test_switcher.py::TestStatus` | pending |
| `test_switcher.py::TestStatusCache` | pending |
| `test_switcher.py::TestFetchAccountUsageSessionProfile` | pending |
| `test_switcher.py::TestAdoptSessionCredential` | pending |
| `test_switcher.py::TestLiveSessionGuardOnAnUnreadableRecord` | pending |
| `test_switcher.py::TestListAccountsUsage` | pending |
| `test_switcher.py::TestUsageFetchStamps` | pending |
| `test_switcher.py::TestActiveAccountRefresh` | pending |
| `test_switcher.py::TestPerformSwitchPostDisplay` | pending |
| `test_switcher.py::TestSwitchToSelfSlotAndForce` | pending |
| `test_switcher.py::TestAccountInfoOrgFields` | pending |
| `test_switcher.py::TestAccountExistsCompositeKey` | pending |
| `test_switcher.py::TestGetCurrentAccountOrgSupport` | pending |
| `test_switcher.py::TestDeadTokenQuarantine` | pending |
| `test_switcher.py::TestAddAccountOrgFields` | pending |
| `test_switcher.py::TestResolveIdentifierAmbiguity` | pending |
| `test_switcher.py::TestListAccountsOrgDisplay` | pending |
| `test_switcher.py::TestBackwardCompatibility` | pending |
| `test_switcher.py::TestUpgradeMigration` | pending |
| `test_switcher.py::TestAddAccountSlot` | pending |
| `test_switcher.py::TestPurgeLegacyCleanup` | pending |
| `test_switcher.py::TestAddAccountFromToken` | pending |
| `test_switcher.py::TestPurge` | pending |
| `test_switcher.py::TestSwitchSkipsBrokenSlots` | pending |
| `test_switcher.py::TestUsageAwareSwitch` | pending |
| `test_switcher.py::TestClaudeCodeLockCooperation` | pending |
| `test_switcher.py::TestMacosKeychainFallback` | pending |
| `test_switcher.py::TestFormatUsageLines` | pending |
| `test_switcher.py::TestProvenanceGuard` | pending |
| `test_switcher.py::TestSelfSwitchProvenance` | pending |
| `test_switcher.py::TestDuplicateAccountDetection` | pending |
| `test_switcher.py::TestLockstepUsageDetection` | pending |
| `test_switcher.py::TestStashAndRetentionStore` | pending |
| `test_switcher.py::TestActiveRefreshProvenance` | pending |
| `test_switcher.py::TestDirectActivationPreservation` | pending |
| `test_switcher.py::TestSharedOAuthCredentialPreservation` | pending |
| `test_switcher.py::TestUuidConflictClassification` | pending |
| `test_switcher.py::TestStashStorageHardening` | pending |
| `test_switcher.py::TestStashManifestConcurrentMutation` | pending |
| `test_switcher.py::TestRemoveAccountPrunesMappings` | pending |
| `test_switcher.py::TestSwitchRemoveGatesAcceptAlias` | pending |
| `test_switcher.py::TestAddAccountAlias` | pending |
| `test_switcher.py::TestDisableEnableAccount` | pending |
| `test_switcher.py::TestDegradedReadProvenance` | pending |
| `test_switcher.py::TestBackupReadTriState` | pending |
| `test_switcher.py::TestEncPermissionDeniedIsUnreadable` | pending |
| `test_switcher.py::TestBackupUnreadableDisplay` | pending |
| `test_switcher.py::TestSwitchUnreadableBackup` | pending |
| `test_switcher.py::TestConsumeGate` | pending |
| `test_switcher.py::TestInactiveRefreshRoutesThroughGate` | pending |
| `test_switcher.py::TestStrikeUnbindsInCollector` | pending |
| `test_switcher.py::TestStoreResolutionParity` | pending |
| `test_switcher.py::TestConsumeGateLockFailures` | pending |
| `test_switcher.py::TestPermanentlyUnreadableStashRow` | pending |
| `test_switcher.py::TestHealedStrikeUnblocksFetching` | pending |
| `test_switcher.py::TestGateUltraReviewFixes` | pending |
| `test_switcher.py::TestActiveSlotStrikeParity` | pending |
| `test_switcher.py::TestUltraReviewCoverageGaps` | pending |
| `test_switcher.py::TestUnreadableBackupIsNotAbsent` | pending |
| `test_switcher.py::TestStashReaderUnreadableVsAbsent` | pending |
| `test_switcher.py::TestSessionShellGuardCoversEveryMutator` | pending |
| `test_switcher.py::TestPollPolicyInputsCarryTheWeeklyLine` | pending |
| `test_switcher.py::TestSwitchTransactionRollback` | pending |
| `test_switcher.py::TestSalvageCopyMode` | pending |
