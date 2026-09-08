import type { Adapter } from '../types';
import { xaiAdapter } from './xai';
import { codexAdapter } from './codex';
import { anthropicAdapter } from './anthropic';

// populated by adapter modules — see src/adapters/{anthropic,codex,xai,kimi}.ts
export const adapters: Adapter[] = [];
import { kimiAdapter } from './kimi';
adapters.push(kimiAdapter);
adapters.push(xaiAdapter);
adapters.push(codexAdapter);
adapters.push(anthropicAdapter);
