import { config } from '../config';
import { loadPlugins } from '../plugins';
import type { Adapter } from '../types';
import { anthropicAdapter } from './anthropic';
import { codexAdapter } from './codex';
import { kimiAdapter } from './kimi';
import { openRouterAdapter } from './openrouter';
import { xaiAdapter } from './xai';

export const builtInAdapters: Adapter[] = [
  kimiAdapter,
  xaiAdapter,
  codexAdapter,
  anthropicAdapter,
  openRouterAdapter,
];

/** Built-ins plus any valid ~/.qlb/plugins/*.js adapters. */
export const adapters: Adapter[] = [
  ...builtInAdapters,
  ...loadPlugins(config.pluginsDir),
];
