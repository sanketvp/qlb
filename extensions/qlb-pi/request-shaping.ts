// Intentionally duplicated from ~/.pi/agent/extensions/anthropic-pool/request-shaping.ts.
// See constants.ts for why this is a copy rather than a cross-extension import.
import { createHash } from "node:crypto";
import {
  BILLING_HEADER_POSITIONS,
  BILLING_HEADER_SALT,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_VERSION,
} from "./constants.js";
import { shapeSystemBlocks, type TextBlock } from "./system-prompt-shaping.js";

type MessageBlock = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

type MessageParam = {
  role?: string;
  content?: string | MessageBlock[];
  [key: string]: unknown;
};

type AnthropicPayload = {
  model?: unknown;
  messages?: unknown;
  system?: unknown;
  stream?: unknown;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicMessagesPayload(payload: unknown): payload is AnthropicPayload {
  return (
    isRecord(payload) &&
    typeof payload.model === "string" &&
    Array.isArray(payload.messages) &&
    typeof payload.stream === "boolean"
  );
}

function getFirstUserText(messages: MessageParam[]): string {
  const firstUserMessage = messages.find((m) => m.role === "user");
  if (!firstUserMessage) return "";

  if (typeof firstUserMessage.content === "string") {
    return firstUserMessage.content;
  }

  if (Array.isArray(firstUserMessage.content)) {
    const firstTextBlock = firstUserMessage.content.find(
      (b) => b.type === "text" && typeof b.text === "string",
    );
    return typeof firstTextBlock?.text === "string" ? firstTextBlock.text : "";
  }

  return "";
}

function buildBillingHeaderValue(messages: MessageParam[]): string | undefined {
  const messageText = getFirstUserText(messages);
  if (!messageText) return undefined;

  const cch = createHash("sha256").update(messageText).digest("hex").slice(0, 5);
  const sampledCharacters = BILLING_HEADER_POSITIONS.map(
    (index) => messageText[index] || "0",
  ).join("");
  const suffix = createHash("sha256")
    .update(`${BILLING_HEADER_SALT}${sampledCharacters}${CLAUDE_CODE_VERSION}`)
    .digest("hex")
    .slice(0, 3);

  return [
    "x-anthropic-billing-header:",
    `cc_version=${CLAUDE_CODE_VERSION}.${suffix};`,
    `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`,
    `cch=${cch};`,
  ].join(" ");
}

function normalizeSystemBlock(block: unknown): TextBlock {
  if (typeof block === "string") {
    return { type: "text", text: block };
  }
  if (isRecord(block) && typeof block.text === "string") {
    return { ...block, type: "text", text: block.text };
  }
  return { type: "text", text: "" };
}

function prependBillingHeader(system: unknown, messages: MessageParam[]): unknown {
  const billingHeader = buildBillingHeaderValue(messages);
  if (!billingHeader) return system;

  const systemBlocks = Array.isArray(system)
    ? system.map(normalizeSystemBlock)
    : system == null
      ? []
      : [normalizeSystemBlock(system)];

  if (systemBlocks.some((b) => b.text.includes("x-anthropic-billing-header:"))) {
    return systemBlocks;
  }

  const billingBlock: TextBlock = { type: "text", text: billingHeader };
  return [billingBlock, ...systemBlocks];
}

function splitAssistantToolUseTrailingContent(messages: MessageParam[]): MessageParam[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message];
    }

    const firstToolUseIndex = message.content.findIndex((b) => b.type === "tool_use");
    if (firstToolUseIndex === -1) return [message];

    const trailingBlocks = message.content.slice(firstToolUseIndex);
    if (!trailingBlocks.some((b) => b.type !== "tool_use")) {
      return [message];
    }

    const nonToolUseBlocks = message.content.filter((b) => b.type !== "tool_use");
    const toolUseBlocks = message.content.filter((b) => b.type === "tool_use");

    return [
      { ...message, content: nonToolUseBlocks },
      { ...message, content: toolUseBlocks },
    ];
  });
}

export function shapeAnthropicOAuthPayload(payload: unknown): unknown {
  if (!isAnthropicMessagesPayload(payload)) {
    return payload;
  }

  const messages = payload.messages as MessageParam[];
  const normalizedMessages = splitAssistantToolUseTrailingContent(messages);

  const shapedSystem = Array.isArray(payload.system)
    ? shapeSystemBlocks(payload.system as TextBlock[])
    : payload.system;
  const finalSystem = prependBillingHeader(shapedSystem, normalizedMessages);

  return {
    ...payload,
    messages: normalizedMessages,
    system: finalSystem,
  };
}
