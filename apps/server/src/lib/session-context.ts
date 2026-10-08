import { Option, Schema } from "effect";
import type { SessionContextUsage } from "@mondash/shared/contract";

const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const stamp = { timestamp: Schema.optional(Schema.String) };
const claudeUsage = Schema.Struct({
  type: Schema.Literal("assistant"),
  ...stamp,
  isSidechain: Schema.optional(Schema.Boolean),
  message: Schema.Struct({
    model: Schema.String,
    usage: Schema.Struct({
      input_tokens: Tokens,
      cache_creation_input_tokens: Schema.optional(Tokens),
      cache_read_input_tokens: Schema.optional(Tokens),
    }),
  }),
});
const claudeIdentity = Schema.Struct({
  type: Schema.Literal("attachment"),
  isSidechain: Schema.optional(Schema.Boolean),
  attachment: Schema.Struct({ type: Schema.Literal("model"), identity: Schema.Struct({ modelId: Schema.String }) }),
});
const claudeCompact = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("compact_boundary"),
  isSidechain: Schema.optional(Schema.Boolean),
  ...stamp,
  compactMetadata: Schema.optional(Schema.Struct({ postTokens: Schema.optional(Tokens) })),
});
const codexUsage = Schema.Struct({
  type: Schema.Literal("event_msg"),
  ...stamp,
  payload: Schema.Struct({
    type: Schema.Literal("token_count"),
    info: Schema.Struct({
      last_token_usage: Schema.Struct({ total_tokens: Tokens }),
      model_context_window: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
    }),
  }),
});
const codexCompact = Schema.Struct({ type: Schema.Literal("compacted"), ...stamp });
const decodeClaude = Schema.decodeUnknownOption(claudeUsage);
const decodeIdentity = Schema.decodeUnknownOption(claudeIdentity);
const decodeCompact = Schema.decodeUnknownOption(claudeCompact);
const decodeCodex = Schema.decodeUnknownOption(codexUsage);
const decodeCodexCompact = Schema.decodeUnknownOption(codexCompact);

function claudeWindow(model: string): number | undefined {
  if (model.endsWith("[1m]")) return 1000000;
  if (model.endsWith("[200k]")) return 200000;
  // Native windows for recognised Anthropic model IDs. Explicit transcript variants take precedence.
  // https://code.claude.com/docs/en/model-config#extended-context
  if (
    [
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
    ].includes(model)
  )
    return 1000000;
  return undefined;
}

/** Provider token receipts from the main session only. Missing capacity stays unknown. */
export function sessionContext(
  tool: "claude" | "codex",
  records: readonly unknown[],
): {
  contextUsage?: SessionContextUsage;
  contextAt?: number;
} {
  let contextUsage: SessionContextUsage | undefined;
  let contextAt: number | undefined;
  let model = "";
  const update = (timestamp: string | undefined, value: SessionContextUsage | undefined) => {
    const parsed = timestamp ? Date.parse(timestamp) : 0;
    const at = Number.isFinite(parsed) ? parsed : 0;
    if (contextAt !== undefined && at < contextAt) return;
    contextUsage = value;
    contextAt = at;
  };
  for (const record of records) {
    if (tool === "codex") {
      const parsed = decodeCodex(record);
      if (Option.isSome(parsed)) {
        const { info } = parsed.value.payload;
        update(parsed.value.timestamp, {
          usedTokens: info.last_token_usage.total_tokens,
          ...(info.model_context_window ? { windowTokens: info.model_context_window } : {}),
        });
      }
      const compacted = decodeCodexCompact(record);
      if (Option.isSome(compacted)) update(compacted.value.timestamp, undefined);
      continue;
    }
    const identity = decodeIdentity(record);
    if (Option.isSome(identity) && !identity.value.isSidechain) model = identity.value.attachment.identity.modelId;
    const compacted = decodeCompact(record);
    if (Option.isSome(compacted) && !compacted.value.isSidechain) {
      const tokens = compacted.value.compactMetadata?.postTokens;
      const windowTokens = claudeWindow(model);
      update(
        compacted.value.timestamp,
        tokens === undefined ? undefined : { usedTokens: tokens, ...(windowTokens ? { windowTokens } : {}) },
      );
    }
    const parsed = decodeClaude(record);
    if (Option.isNone(parsed) || parsed.value.isSidechain || parsed.value.message.model === "<synthetic>") continue;
    const { message } = parsed.value;
    if (model.replace(/\[(?:1m|200k)\]$/, "") !== message.model) model = message.model;
    const windowTokens = claudeWindow(model);
    // Match Claude's statusline: input + cache reads + cache writes; output isn't counted in used_percentage.
    // https://code.claude.com/docs/en/statusline#context-window-fields
    update(parsed.value.timestamp, {
      usedTokens:
        message.usage.input_tokens +
        (message.usage.cache_creation_input_tokens ?? 0) +
        (message.usage.cache_read_input_tokens ?? 0),
      ...(windowTokens ? { windowTokens } : {}),
    });
  }
  return { contextUsage, contextAt };
}
