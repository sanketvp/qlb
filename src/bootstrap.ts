export class TestHomeRequiresTestModeError extends Error {
  readonly code = 'QLB_TEST_HOME_REQUIRES_TEST_MODE';

  constructor() {
    super('QLB_HOME requires QLB_TEST_MODE=1 so test data cannot mix with real credentials');
    this.name = 'TestHomeRequiresTestModeError';
  }
}

export interface BootstrapHooks {
  /** K13 admission runs before any reconciliation (S43/S59). */
  assertAdmitted?: () => void | Promise<void>;
  reconcileJournals?: () => void | Promise<void>;
}

/** Native credential access is prohibited in every test process. */
export function nativeAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QLB_TEST_MODE === undefined;
}

export function assertTestHomeIsIsolated(env: NodeJS.ProcessEnv = process.env): void {
  if (env.QLB_HOME !== undefined && env.QLB_TEST_MODE !== '1') {
    throw new TestHomeRequiresTestModeError();
  }
}

/**
 * Placeholder for the ordered lifecycle/journal startup hooks added by K13/K14.
 * Keeping this hook centralized makes the required admission-before-reconciliation
 * order explicit without making R0 depend on those slices.
 */
export async function bootstrap(
  hooks: BootstrapHooks = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertTestHomeIsIsolated(env);
  await hooks.assertAdmitted?.();
  await hooks.reconcileJournals?.();
}
