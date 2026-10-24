/*
 * Ported from claude-swap v0.28.0.
 * Upstream file(s): src/claude_swap/autoswitch.py, src/claude_swap/launch_agent.py.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

import { join } from 'node:path';

import { loadProviderStub } from './provider-loader';

/** Provider module loader. The polling loop is added by slice K7. */
export function loadAutoProvider(provider: string): unknown {
  return loadProviderStub(provider, join(__dirname, 'auto'));
}
