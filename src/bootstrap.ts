export interface BootstrapHooks {
  assertAdmitted?: () => void | Promise<void>;
  reconcileJournals?: () => void | Promise<void>;
}

/** Native credential access is prohibited in every test process. */
export function nativeAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QLB_TEST_MODE !== '1';
}

/**
 * Placeholder for the ordered lifecycle/journal startup hooks added by K13/K14.
 * Keeping this hook centralized makes the required admission-before-reconciliation
 * order explicit without making R0 depend on those slices.
 */
export async function bootstrap(hooks: BootstrapHooks = {}): Promise<void> {
  await hooks.assertAdmitted?.();
  await hooks.reconcileJournals?.();
}
