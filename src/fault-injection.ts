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

export type InjectionForm = 'fail-step' | 'usage-5xx' | 'breaker-rows';

const FORM_USAGE: Record<InjectionForm, string> = {
  'fail-step': 'fail-step <7|8|9>',
  'usage-5xx': 'usage-5xx anthropic',
  'breaker-rows': 'breaker-rows anthropic',
};
const ALL_FORMS: readonly InjectionForm[] = ['fail-step', 'usage-5xx', 'breaker-rows'];

function injectUsage(forms: readonly InjectionForm[]): string {
  const listed = forms.map((form) => FORM_USAGE[form]);
  return `usage: --inject ${listed.length === 1 ? listed[0] : `<${listed.join('|')}>`}`;
}

export function faultInjectionEnabled(env: FaultInjectionEnvironment): boolean {
  return env.QLB_FAULT_INJECTION === '1';
}

/**
 * `forms` names the injection forms the calling command accepts. It shapes
 * only the usage text; every command still rejects the other forms itself.
 */
export function parseInjectFlag(
  args: readonly string[],
  env: FaultInjectionEnvironment,
  forms: readonly InjectionForm[] = ALL_FORMS,
): ParseInjectFlagResult {
  const usage = injectUsage(forms);
  const flagIndexes = args.reduce<number[]>((indexes, arg, index) => {
    if (arg === '--inject') indexes.push(index);
    return indexes;
  }, []);
  const hasEqualsSpelling = args.some((arg) => arg.startsWith('--inject='));
  if (flagIndexes.length === 0 && !hasEqualsSpelling) {
    return { rest: [...args], inject: null };
  }

  if (!faultInjectionEnabled(env)) {
    return { usage: `${usage} requires QLB_FAULT_INJECTION=1` };
  }
  if (flagIndexes.length !== 1 || hasEqualsSpelling) {
    return { usage };
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
  return { usage };
}

export function injectionDetail(inject: FailStepInjection | UsageInjection | BreakerRowsInjection): string {
  switch (inject.kind) {
    case 'fail-step': return `fault-injection:fail-step-${inject.step}`;
    case 'usage-5xx': return 'fault-injection:usage-5xx';
    case 'breaker-rows': return 'fault-injection:breaker-rows';
  }
}
