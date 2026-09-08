// Intentionally duplicated from ~/.pi/agent/extensions/anthropic-pool/system-prompt-shaping.ts.
// See constants.ts for why this is a copy rather than a cross-extension import.
import {
  MINIMAL_ANTHROPIC_OAUTH_PROMPT,
  PARAGRAPH_REMOVAL_ANCHORS,
  PI_DEFAULT_PROMPT_PREFIX,
  PI_DEFAULT_PROMPT_TERMINATOR,
  TEXT_REPLACEMENTS,
} from "./constants.js";

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
  [key: string]: unknown;
}

export function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false;
    }
    return true;
  });

  let result = filtered.join("\n\n");
  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replaceAll(rule.match, rule.replacement);
  }

  return result.trim();
}

export function shapeAnthropicOAuthSystemPrompt(systemPrompt: string): string {
  const prefixIdx = systemPrompt.indexOf(PI_DEFAULT_PROMPT_PREFIX);
  if (prefixIdx === -1) {
    return systemPrompt;
  }

  const terminatorIdx = systemPrompt.indexOf(
    PI_DEFAULT_PROMPT_TERMINATOR,
    prefixIdx,
  );

  const spanEnd =
    terminatorIdx !== -1
      ? terminatorIdx + PI_DEFAULT_PROMPT_TERMINATOR.length
      : systemPrompt.length;

  const span = systemPrompt.slice(prefixIdx, spanEnd);
  const sanitized = sanitizeSystemText(span);
  const shapedSpan = sanitized
    ? `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}\n\n${sanitized}`
    : MINIMAL_ANTHROPIC_OAUTH_PROMPT;

  return (
    systemPrompt.slice(0, prefixIdx) + shapedSpan + systemPrompt.slice(spanEnd)
  );
}

export function shapeSystemBlocks(blocks: TextBlock[]): TextBlock[] {
  return blocks.map((block) => {
    if (block.type !== "text" || !block.text.includes(PI_DEFAULT_PROMPT_PREFIX)) {
      return block;
    }
    return { ...block, text: shapeAnthropicOAuthSystemPrompt(block.text) };
  });
}
