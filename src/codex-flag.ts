/**
 * Dark-launch gate; C8 flips this only alongside its background watch consumer.
 * It lives on its own so the consume path can stamp stop rows with it without
 * an import cycle; `codex-switch.ts` re-exports it.
 */
export const CODEX_SWITCH_COMMAND_ENABLED = false;
