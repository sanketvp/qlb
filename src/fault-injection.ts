export type FaultInjectionEnvironment = Readonly<Record<string, string | undefined>>;

export type FailStepInjection = {
  kind: 'fail-step';
  step: 7 | 8 | 9;
};

export type UsageInjection = {
  kind: 'usage-5xx';
  provider: 'anthropic';
};

export type BreakerRowsInjection = {
  kind: 'breaker-rows';
  provider: 'anthropic';
};

export type ParseInjectFlagResult =
  | { rest: string[]; inject: FailStepInjection | UsageInjection | BreakerRowsInjection | null }
  | { usage: string };

const INJECT_USAGE = 'usage: --inject <fail-step <7|8|9>|usage-5xx anthropic|breaker-rows anthropic>';
const INJECT_ENV_USAGE = `${INJECT_USAGE} requires QLB_FAULT_INJECTION=1`;

export function faultInjectionEnabled(env: FaultInjectionEnvironment): boolean {
  return env.QLB_FAULT_INJECTION === '1';
}

export function parseInjectFlag(args: readonly string[], env: FaultInjectionEnvironment): ParseInjectFlagResult {
  const flagIndexes = args.reduce<number[]>((indexes, arg, index) => {
    if (arg === '--inject') indexes.push(index);
    return indexes;
  }, []);
  const hasEqualsSpelling = args.some((arg) => arg.startsWith('--inject='));
  if (flagIndexes.length === 0 && !hasEqualsSpelling) {
    return { rest: [...args], inject: null };
  }

  if (!faultInjectionEnabled(env)) {
    return { usage: INJECT_ENV_USAGE };
  }
  if (flagIndexes.length !== 1 || hasEqualsSpelling) {
    return { usage: INJECT_USAGE };
  }

  const flagIndex = flagIndexes[0];
  const kind = args[flagIndex + 1];
  const value = args[flagIndex + 2];
  if (kind === 'fail-step' && (value === '7' || value === '8' || value === '9')) {
    return {
      rest: [...args.slice(0, flagIndex), ...args.slice(flagIndex + 3)],
      inject: { kind: 'fail-step', step: Number(value) as 7 | 8 | 9 },
    };
  }
  if ((kind === 'usage-5xx' || kind === 'breaker-rows') && value === 'anthropic') {
    return {
      rest: [...args.slice(0, flagIndex), ...args.slice(flagIndex + 3)],
      inject: { kind, provider: 'anthropic' },
    };
  }
  return { usage: INJECT_USAGE };
}

export function injectionDetail(inject: FailStepInjection | UsageInjection | BreakerRowsInjection): string {
  switch (inject.kind) {
    case 'fail-step': return `fault-injection:fail-step-${inject.step}`;
    case 'usage-5xx': return 'fault-injection:usage-5xx';
    case 'breaker-rows': return 'fault-injection:breaker-rows';
  }
}
