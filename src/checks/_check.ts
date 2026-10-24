import { redactError } from '../redact';
import type { CheckDefinition } from '../registry';
import type { HealthCheck } from './claude-slots';

export function check(name: string, prefix?: string): CheckDefinition {
  return prefix ? { name, prefix } : { name };
}

/** Converts unexpected diagnostic failures into a safe FAIL result. */
export function guardCheck(name: string, run: () => HealthCheck): HealthCheck {
  try {
    return run();
  } catch (error) {
    return { name, level: 'FAIL', message: `check failed: ${redactError(error, [])}` };
  }
}
