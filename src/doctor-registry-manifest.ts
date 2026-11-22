import type { CheckDefinition } from './registry';

/**
 * Complete build-time contract between doctor declarations and its runtime
 * registry. It deliberately includes checks that are quiet on many hosts.
 */
export const DOCTOR_REGISTRY_MANIFEST: readonly CheckDefinition[] = [
  { name: 'auto:agent' },
  { name: 'auto:anthropic:breaker' },
  { name: 'auto:parked' },
  { name: 'claude:active' },
  { name: 'claude:config-file' },
  { name: 'claude:config-path' },
  { name: 'claude:locks' },
  { name: 'claude:login-expiry' },
  { name: 'claude:oauth-client' },
  { name: 'claude:slots' },
  { name: 'claude:switch-journal' },
  { name: 'claude:unclaimed' },
  { name: 'claude:unpersisted-token' },
  { name: 'claude:version-drift' },
  { name: 'codex:first-switch' },
  { name: 'codex:slots' },
  { name: 'codex:usage-shape' },
  { name: 'consume:marker' },
  { name: 'cswap:agent' },
  { name: 'cswap:processes' },
  { name: 'doctor:registry' },
  { name: 'fs:stray-temps' },
  { name: 'hermes' },
  { name: 'hermes:branch' },
  { name: 'hermes:checkout' },
  { name: 'hermes:codex-fix' },
  { name: 'hermes:config' },
  { name: 'hermes:integration' },
  { name: 'hermes:models' },
  { name: 'hermes:plugin' },
  { name: 'hermes:proxy-supervisor' },
  { name: 'hermes:seam', prefix: 'hermes:seam' },
  { name: 'hermes:version' },
  { name: 'hosts:env' },
  { name: 'journal:in-progress' },
  { name: 'journal:orphaned' },
  { name: 'keychain' },
  { name: 'keychain:helper' },
  { name: 'keychain:live-items-authorized' },
  { name: 'lifecycle:drill' },
  { name: 'lifecycle:phase' },
  { name: 'lifecycle:window' },
  { name: 'migrations' },
  { name: 'native-sync', prefix: 'native-sync' },
  { name: 'pi' },
  { name: 'pi:evidence-gap' },
  { name: 'pi:extension' },
  { name: 'pi:extension-drift' },
  { name: 'pi:models-json-openrouter' },
  { name: 'pi:seam:after_provider_response' },
  { name: 'pi:seam:anthropicMessagesApi' },
  { name: 'pi:seam:model_select' },
  { name: 'pi:seam:registerProvider' },
  { name: 'pi:stale-sessions' },
  { name: 'pi:typecheck' },
  { name: 'recovery' },
  { name: 'release:current' },
  { name: 'relogin:7d' },
  { name: 'sqlite' },
  { name: 'stash:libsecret', prefix: 'stash:libsecret' },
  { name: 'undo:incomplete' },
  { name: 'undo:lineage-match' },
  { name: 'usage:provider-discrepancies' },
];

function signature(definition: CheckDefinition): string {
  return `${definition.name}\u0000${definition.prefix ?? ''}`;
}

function describe(signatureValue: string): string {
  const [name, prefix] = signatureValue.split('\u0000');
  return prefix === '' ? name! : `${name} (prefix ${prefix})`;
}

/** Returns deterministic declaration/wiring differences for the build gate. */
export function doctorRegistryManifestProblems(definitions: readonly CheckDefinition[]): string[] {
  const expected = new Set(DOCTOR_REGISTRY_MANIFEST.map(signature));
  const actual = new Set(definitions.map(signature));
  return [
    ...[...expected].filter((entry) => !actual.has(entry)).map((entry) => `missing ${describe(entry)}`),
    ...[...actual].filter((entry) => !expected.has(entry)).map((entry) => `unexpected ${describe(entry)}`),
  ].sort();
}
