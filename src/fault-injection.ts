export type FaultInjectionEnvironment = Readonly<Record<string, string | undefined>>;

export type FailStepInjection = {
  kind: 'fail-step';
  step: 7 | 8 | 9;
};

export type ParseInjectFlagResult =
  | { rest: string[]; inject: FailStepInjection | null }
  | { usage: string };

const INJECT_USAGE = 'usage: --inject fail-step <7|8|9> requires QLB_FAULT_INJECTION=1';

export function faultInjectionEnabled(env: FaultInjectionEnvironment): boolean {
  return env.QLB_FAULT_INJECTION === '1';
}

export function parseInjectFlag(args: readonly string[], env: FaultInjectionEnvironment): ParseInjectFlagResult {
  const flagIndex = args.indexOf('--inject');
  if (flagIndex === -1) {
    return { rest: [...args], inject: null };
  }

  const kind = args[flagIndex + 1];
  const step = args[flagIndex + 2];
  if (!faultInjectionEnabled(env) || kind !== 'fail-step' || (step !== '7' && step !== '8' && step !== '9')) {
    return { usage: INJECT_USAGE };
  }

  return {
    rest: [...args.slice(0, flagIndex), ...args.slice(flagIndex + 3)],
    inject: { kind: 'fail-step', step: Number(step) as 7 | 8 | 9 },
  };
}

export function injectionDetail(inject: FailStepInjection): string {
  return `fault-injection:fail-step-${inject.step}`;
}
