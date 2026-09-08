import type { Adapter } from '../types';
import { codexAdapter } from './codex';
import { anthropicAdapter } from './anthropic';

// populated by adapter modules — see src/adapters/{anthropic,codex,xai,kimi}.ts
export const adapters: Adapter[] = [];
adapters.push(codexAdapter);
adapters.push(anthropicAdapter);
