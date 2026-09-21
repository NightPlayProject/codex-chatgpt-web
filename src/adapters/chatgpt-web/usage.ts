import { estimateTokens } from "../../lib/token-estimate";
import { skillFileTokens } from "./skill-attachments";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebBrowserStagingTokenLimit,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import { compiledChatGptWebMaxMessageChars, compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  CHATGPT_MAX_MULTIPART_PARTS,
  compileChatGptWebPrompt,
  type ChatGptWebMultipartPartCount,
  type CompiledChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
} from "./prompt";
import { extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";
import { isReadableCompactionSummaryText } from "../../responses/compaction";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

/**
 * ChatGPT's nominal High composer limit is much larger, but live Desktop traces repeatedly showed
 * accepted ~208-209k-character inline submissions fail in the product before any MCP claim while
 * the same canonical context succeeds through two acknowledged parts. A later real existing-thread
 * trace reproduced the same terminal ChatGPT generation failure four consecutive times at 159,147
 * browser-composer characters while a fresh small High turn succeeded through the same bridge.
 * Keep a conservative margin below the lowest reproduced failure point and use the existing lossless
 * multipart transport before Send is ever activated. This is a reliability guard, not a larger
 * model-context entitlement.
 */
export const CHATGPT_STANDARD_RELIABLE_INLINE_CHAR_LIMIT = 158_000;

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

/**
 * Native Codex keeps the full tool schemas in its canonical prompt even though the ChatGPT browser
 * transport exposes local tools through the bridge/MCP control plane instead of replaying those
 * schemas into the visible prompt. Native auto-compaction is driven by the usage we report back to
 * Codex, so reporting only the browser-compiled prompt can materially under-count a large direct
 * tool catalog and let native history reach its hard context window before /responses/compact runs.
 *
 * Keep browser transport accounting unchanged; this reserve exists only in provider usage reported
 * to native Codex. The parsed catalog is already the normalized union of declared/additional/search
 * tools, so serializing it gives a conservative approximation of the schema footprint Codex owns.
 */
function estimateNativeSolToolCatalogTokens(parsed: CodexParsedRequest): number {
  if (parsed.modelId !== CHATGPT_WEB_MODEL_ID || parsed._compactionRequest) return 0;
  const tools = parsed.context.tools ?? [];
  if (tools.length === 0) return 0;
  return conservativeTextTokens(JSON.stringify(tools), parsed.modelId);
}

function nativeUsageContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (!part || typeof part !== "object") return part;
    const candidate = part as { type?: unknown; detail?: unknown };
    // Base64 bytes are transport, not native text-context pressure. Keep one bounded image marker
    // so vision history is represented without turning encoded file size into fake text tokens.
    if (candidate.type === "image") {
      return { type: "image", detail: typeof candidate.detail === "string" ? candidate.detail : "auto" };
    }
    return part;
  });
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawUsageMessageText(value: unknown): string {
  const item = usageRecord(value);
  if (!item || item.role !== "user") return "";
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map(part => {
      const block = usageRecord(part);
      return block && (block.type === "input_text" || block.type === "text") && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("");
}

/**
 * Native Responses history can contain opaque items that parser.ts deliberately cannot turn into
 * replayable ChatGPT messages (most importantly provider-owned encrypted reasoning). Those bytes
 * still consume the native Codex context window. Preserve them for provider-usage accounting while
 * replacing inline image payloads with bounded markers so base64 transport is never mistaken for
 * text-context pressure.
 */
function nativeRawUsageValue(value: unknown, property?: string): unknown {
  if (Array.isArray(value)) return value.map(entry => nativeRawUsageValue(entry));
  const object = usageRecord(value);
  if (!object) {
    if (property === "image_url" && typeof value === "string" && value.startsWith("data:image/")) {
      return "[inline image payload omitted from text token accounting]";
    }
    return value;
  }

  const type = typeof object.type === "string" ? object.type : undefined;
  if (type === "input_image" || type === "image") {
    return {
      type,
      ...(typeof object.detail === "string" ? { detail: object.detail } : {}),
      ...(typeof object.file_id === "string" ? { file_id: object.file_id } : {}),
      image: "[structured image]",
    };
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, nativeRawUsageValue(entry, key)]),
  );
}

function latestRawCompactionBoundary(input: readonly unknown[]): number {
  let boundary = -1;
  for (let index = 0; index < input.length; index += 1) {
    const item = usageRecord(input[index]);
    if (!item) continue;
    if (item.type === "compaction" || item.type === "compaction_summary") {
      boundary = index;
      continue;
    }
    if (item.type === "context_compaction" && typeof item.encrypted_content === "string") {
      boundary = index;
      continue;
    }
    if (
      item.type === "context_compaction"
      && typeof item.encrypted_content !== "string"
      && index + 1 < input.length
      && isReadableCompactionSummaryText(rawUsageMessageText(input[index + 1]))
    ) {
      // codex-rs local compaction writes a payloadless marker followed by the readable replacement
      // summary. The marker alone is not proof that compaction completed, so only rebase usage once
      // its summary is present. Start at the summary so superseded pre-compaction history stops
      // driving another automatic compact immediately after the successful one.
      boundary = index + 1;
    }
  }
  return boundary;
}

/**
 * Count the effective raw native history in addition to the normalized semantic history above.
 * Remote v2 compaction leaves its source records before a replacement item on the wire, so start at
 * the newest replacement boundary rather than counting history that the compaction semantically
 * superseded. This closes the gap where opaque native reasoning was absent from parsed messages and
 * Codex could hit its hard context window before our reported usage reached the auto-compact limit.
 */
function estimateNativeSolRawHistoryTokens(parsed: CodexParsedRequest): number {
  if (parsed.modelId !== CHATGPT_WEB_MODEL_ID || parsed._compactionRequest) return 0;
  const body = usageRecord(parsed._rawBody);
  if (!body) return 0;
  const input = Array.isArray(body.input) ? body.input : [];
  const boundary = latestRawCompactionBoundary(input);
  const effectiveInput = boundary >= 0 ? input.slice(boundary) : input;
  const instructions = body.instructions;
  if (instructions === undefined && effectiveInput.length === 0) return 0;
  return conservativeTextTokens(JSON.stringify(nativeRawUsageValue({
    ...(instructions !== undefined ? { instructions } : {}),
    input: effectiveInput,
  })), parsed.modelId);
}

/**
 * Native Codex retains canonical history independently of the smaller prompt that the browser
 * adapter may reconstruct from a rolling checkpoint. Provider usage drives native auto-compaction,
 * so Sol usage must continue to grow with that canonical history until Codex replaces it with an
 * explicit compaction item. Exclude transport-only provenance/timestamps while preserving every
 * semantic message, tool call/result, and system/developer instruction.
 */
function estimateNativeSolCanonicalHistoryTokens(parsed: CodexParsedRequest): number {
  if (parsed.modelId !== CHATGPT_WEB_MODEL_ID || parsed._compactionRequest) return 0;
  const rawBody = usageRecord(parsed._rawBody);
  const rawInput = rawBody && Array.isArray(rawBody.input) ? rawBody.input : undefined;
  if (rawInput && latestRawCompactionBoundary(rawInput) >= 0) {
    // After an authoritative wire compaction boundary, raw usage is the canonical provider view.
    // parser.ts intentionally keeps some local-compaction semantic history available for continuity,
    // so counting parsed.context.messages as well would resurrect superseded history and cause
    // compaction storms. Browser usage still accounts for the effective reconstructed prompt.
    return 0;
  }
  const messages = parsed.context.messages.map(message => {
    switch (message.role) {
      case "user":
      case "agentMessage":
      case "developer":
        return { role: message.role, content: nativeUsageContent(message.content) };
      case "toolResult":
        return {
          role: message.role,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: nativeUsageContent(message.content),
          isError: message.isError,
        };
      case "assistant":
        return { role: message.role, content: message.content, ...(message.phase ? { phase: message.phase } : {}) };
    }
  });
  return conservativeTextTokens(JSON.stringify({
    systemPrompt: parsed.context.systemPrompt ?? [],
    messages,
  }), parsed.modelId);
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: CompileChatGptWebPromptOptions = {},
): number {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      // Usage accounting may run after a retained native-goal tool round whose fresh wrapper is no
      // longer replayed. It must estimate the already-established retained prompt without turning
      // the old human source back into the active task.
      retainedGoalResume: true,
      ...options,
      ...(manual ? { manualControl: true as const } : {}),
      captureLunaCheckpoint: (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID || parsed.modelId === CHATGPT_WEB_MODEL_ID)
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
}

/**
 * The compaction threshold chooses the initial part count. Whole records and composer limits
 * can require more parts even when the total token estimate is small. Plan before submission;
 * compaction starts at three parts and expands only when measured browser stage budgets require it.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: Pick<CompileChatGptWebPromptOptions, "retainedGoalResume" | "experimentalSkillAttachments"> = {},
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const { contextWindow } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const browserStagingTokenLimit = resolveChatGptWebBrowserStagingTokenLimit(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    capabilities,
  );
  if (browserStagingTokenLimit === undefined) {
    throw new Error("Bigger Context browser staging limit is unavailable for this model");
  }
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    { ...options, experimentalMultipartParts: parts },
  );
  const fits = (compiled: CompiledChatGptWebPrompt): boolean => {
    const messages = compiledChatGptWebMessages(compiled);
    // Inert stages may use any explicitly available staging effort; execution keeps the chosen
    // effort. These are the widest stage modes used by the browser's existing selector.
    const stagingEffort = capabilities.proAvailable ? "max" : "medium";
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_BACKEND_MODEL,
        effort,
        capabilities,
        final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
      );
      if (estimateTokens(text, parsed.modelId) > budget) return false;
    }
    return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId) < contextWindow * messages.length;
  };
  const firstFittingMultipart = (minimumParts: ChatGptWebMultipartPartCount): ChatGptWebMultipartPartCount => {
    for (let candidate = minimumParts; candidate <= CHATGPT_MAX_MULTIPART_PARTS; candidate += 1) {
      const parts = candidate as ChatGptWebMultipartPartCount;
      if (fits(compile(parts))) return parts;
    }
    throw new Error(
      `Bigger Context cannot fit this request within ${CHATGPT_MAX_MULTIPART_PARTS} browser stages without splitting an individual semantic record`,
    );
  };
  if (parsed._compactionRequest) return firstFittingMultipart(CHATGPT_BIGGER_CONTEXT_PARTS);
  const inline = compile();
  const inputTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  const initialParts = biggerContextPartCount(inputTokens, browserStagingTokenLimit, false);
  if (initialParts === undefined && fits(inline)) return undefined;
  if (fits(compile(2))) return 2;
  return firstFittingMultipart(CHATGPT_BIGGER_CONTEXT_PARTS);
}

/**
 * Standard Context normally remains one browser message. For empirically unstable very-large Sol
 * inline envelopes, stage the same ordered semantic records in two messages proactively. The
 * multipart compiler binds execution to the provenance-validated active request and stages carry
 * no connector/tool capability, so this never replays a task after an ambiguous Send.
 */
export function resolveStandardContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: Pick<CompileChatGptWebPromptOptions, "retainedGoalResume" | "experimentalSkillAttachments"> = {},
): ChatGptWebMultipartPartCount | undefined {
  if (parsed._compactionRequest
    || isChatGptWebZeroRiskBackendModel(parsed.modelId)
    || parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) return undefined;
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const inline = compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    options,
  );
  const maxChars = compiledChatGptWebMaxMessageChars(inline);
  // Retained native goal resumes have a stricter browser-generation failure
  // boundary than ordinary large turns. Keep the same context records and
  // authority model, but give the final execution commit a smaller reconstruction
  // burden by using the three-part transport when a large goal resume is staged.
  if (options.retainedGoalResume && maxChars >= CHATGPT_STANDARD_RELIABLE_INLINE_CHAR_LIMIT) {
    return CHATGPT_BIGGER_CONTEXT_PARTS;
  }
  return maxChars >= CHATGPT_STANDARD_RELIABLE_INLINE_CHAR_LIMIT
    ? 2
    : undefined;
}

export function biggerContextPartCount(
  inputTokens: number,
  onePartLimit: number,
  compaction: boolean,
): ChatGptWebMultipartPartCount | undefined {
  if (compaction) return CHATGPT_BIGGER_CONTEXT_PARTS;
  if (inputTokens < onePartLimit) return undefined;
  if (inputTokens < onePartLimit * 2) return 2;
  return CHATGPT_BIGGER_CONTEXT_PARTS;
}

function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
  experimentalSkillAttachments = false,
): CodexUsage {
  const browserInputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    experimentalSkillAttachments,
    experimentalMultipartParts: experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities, {
        retainedGoalResume: true,
        experimentalSkillAttachments,
      })
      : undefined,
  });
  const nativeHistoryTokens = Math.max(
    estimateNativeSolCanonicalHistoryTokens(parsed),
    estimateNativeSolRawHistoryTokens(parsed),
  );
  const inputTokens = Math.max(browserInputTokens, nativeHistoryTokens)
    + estimateNativeSolToolCatalogTokens(parsed);
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
