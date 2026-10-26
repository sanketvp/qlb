import { GateFailure, type ProviderGate } from '../pi-gate';
import { resolve } from '../token/kimi-coding';

/** P13 replaces this temporary refresh refusal with single-consume. */
const gate: ProviderGate = {
  read: resolve,
  refresh: () => { throw new GateFailure('not-implemented'); },
};

export default gate;
