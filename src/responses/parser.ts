import type {
  CodexAgentMessage,
  CodexAssistantMessage,
  CodexContentPart,
  CodexContext,
  CodexMessage,
  CodexParsedRequest,
  CodexRequestOptions,
  CodexTextContent,
  CodexThinkingContent,
  CodexTool,
  CodexToolCall,
  CodexUserMessage,
} from "../types";
import { namespacedToolName } from "../types";
import { responsesRequestSchema } from "./schema";
import {
  compactionItemToText,
  isNativeGoalContextItem,
  isOnePixelPngDataUrl,
  isReadableCompactionSummaryText,
} from "./compaction";
import { previousResponseReplayPrefixLength } from "./state";
import { decodeReasoningEnvelope } from "./reasoning-envelope";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type InputBlock =
  | { type: "input_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: string }
  | { type: "input_file"; file_id?: string; filename?: string };

const PRE_COMPACTION_IMAGE_NOTE =
  "[pre-compaction image not reattached; rely on the compaction summary for retained visual context]";

function inputBlocksText(blocks: unknown[] | string | undefined): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block): block is { type: "input_text" | "text"; text: string } => (
      isObj(block)
      && (block.type === "input_text" || block.type === "text")
      && typeof block.text === "string"
    ))
    .map(block => block.text)
    .join("");
}

function latestCompactionBoundaryIndex(input: readonly unknown[]): number {
  let boundary = -1;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isObj(item)) continue;
    const effectiveType = typeof item.type === "string"
      ? item.type
      : "role" in item
        ? "message"
        : undefined;
    if (
      effectiveType === "compaction"
      || effectiveType === "compaction_summary"
      || effectiveType === "context_compaction"
    ) {
      boundary = index;
      continue;
    }
    if (
      effectiveType === "message"
      && item.role === "user"
      && isReadableCompactionSummaryText(inputBlocksText(item.content as unknown[] | string | undefined))
    ) {
      boundary = index;
    }
  }
  return boundary;
}

function inputContentParts(
  blocks: unknown[] | string | undefined,
  omitImages = false,
): string | CodexContentPart[] {
  if (typeof blocks === "string") return blocks;
  if (!blocks) return [];
  const parts: CodexContentPart[] = [];
  for (const raw of blocks) {
    const block = raw as InputBlock;
    if (block.type === "input_text" || block.type === "text") {
      parts.push({ type: "text", text: (block as { text: string }).text });
    } else if (block.type === "input_image") {
      const b = block as { image_url?: string; file_id?: string; detail?: string };
      if (b.image_url) {
        if (omitImages) {
          if (isOnePixelPngDataUrl(b.image_url)) continue;
          parts.push({ type: "text", text: PRE_COMPACTION_IMAGE_NOTE });
          continue;
        }
        // Preserve the image as a structured part — adapters send it as a native image block.
        // NEVER inline the (often base64 data-URL) image_url as text: that explodes the token count.
        parts.push({ type: "image", imageUrl: b.image_url, ...(b.detail ? { detail: normalizeImageDetail(b.detail) } : {}) });
      } else {
        parts.push({ type: "text", text: `[image: ${b.file_id ?? "?"}]` }); // file_id ref → no inline data
      }
    } else if (block.type === "input_file") {
      const ref = (block as { file_id?: string; filename?: string }).file_id ?? (block as { filename?: string }).filename ?? "?";
      parts.push({ type: "text", text: `[file: ${ref}]` });
    }
  }
  // Collapse to a plain string only for a single TEXT part; images must stay structured.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function containsOpaqueEncryptedContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(block => isObj(block)
    && block.type === "encrypted_content"
    && typeof block.encrypted_content === "string"
    && block.encrypted_content.length > 0);
}

type OutputBlock = { type: "output_text"; text: string } | { type: "text"; text: string } | { type: "refusal"; refusal: string };

function outputTextOf(blocks: unknown[] | string | undefined): CodexTextContent[] {
  if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
  if (!blocks) return [];
  const out: CodexTextContent[] = [];
  for (const raw of blocks) {
    const b = raw as OutputBlock;
    if (b.type === "output_text" || b.type === "text") out.push({ type: "text", text: (b as { text: string }).text });
    else if (b.type === "refusal") out.push({ type: "text", text: `[refusal: ${(b as { refusal: string }).refusal}]` });
  }
  return out;
}

function mapToolChoice(value: unknown): CodexRequestOptions["toolChoice"] {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isObj(value) && "type" in value) {
    const t = (value as { type: string }).type;
    if ((t === "function" || t === "custom") && "name" in value) {
      return { name: (value as { name: string }).name };
    }
    if (t === "allowed_tools" && Array.isArray(value.tools)) {
      const names = value.tools
        .map(allowedToolName)
        .filter((name): name is string => Boolean(name));
      return names.length > 0
        ? { allowedTools: [...new Set(names)], mode: value.mode === "required" ? "required" : "auto" }
        : "none";
    }
    return "auto";
  }
  return undefined;
}

function allowedToolName(tool: unknown): string | undefined {
  if (!isObj(tool)) return undefined;
  if (typeof tool.name === "string" && tool.name.length > 0) {
    const namespace = typeof tool.namespace === "string"
      && tool.namespace.length > 0
      && tool.namespace !== DEFAULT_FUNCTION_NAMESPACE
      ? tool.namespace
      : undefined;
    return namespacedToolName(namespace, tool.name);
  }
  if (tool.type === "web_search" || tool.type === "web_search_preview") return "web_search";
  if (tool.type === "tool_search") return "tool_search";
  return undefined;
}

function parseTextControls(value: unknown): Pick<CodexRequestOptions, "verbosity" | "outputFormat"> {
  if (!isObj(value)) return {};
  const out: Pick<CodexRequestOptions, "verbosity" | "outputFormat"> = {};
  if (value.verbosity === "low" || value.verbosity === "medium" || value.verbosity === "high") {
    out.verbosity = value.verbosity;
  }
  const format = value.format;
  if (
    isObj(format)
    && format.type === "json_schema"
    && typeof format.name === "string"
    && format.name.length > 0
    && format.schema !== undefined
  ) {
    out.outputFormat = {
      type: "json_schema",
      name: format.name,
      strict: format.strict === true,
      schema: structuredClone(format.schema),
    };
  }
  return out;
}

const DEFAULT_FUNCTION_NAMESPACE = "functions";

function normalizedToolNamespace(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value !== DEFAULT_FUNCTION_NAMESPACE
    ? value
    : undefined;
}

/**
 * Codex has emitted tool collections as arrays, namespace descriptors with an array of children,
 * and object maps across Responses and Responses Lite revisions. Preserve map keys when a
 * descriptor omits its name; those keys are often the only exact wire name available for a native
 * MCP or Computer Use tool.
 *
 * A newer native registry shape nests a namespace directly as a map, for example:
 * `{ "Microsoft.windows.Computer": { "get_app_state": { ... } } }`.
 * Treat that outer key as a namespace instead of manufacturing a zero-argument function named
 * `Microsoft.windows.Computer`. This keeps every child callable while retaining punctuation in the
 * exact namespace and wire name.
 */
function toolContainerEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isObj);
  if (!isObj(value)) return [];

  const looksLikeDescriptor = typeof value.type === "string"
    || typeof value.name === "string"
    || typeof value.description === "string"
    || "tools" in value
    || "parameters" in value
    || "input_schema" in value
    || "inputSchema" in value
    || "schema" in value
    || "format" in value;
  if (looksLikeDescriptor) return [value];

  return Object.entries(value).flatMap(([key, raw]) => {
    if (Array.isArray(raw)) {
      return [{ type: "namespace", name: key, tools: raw }];
    }
    if (!isObj(raw)) return [];
    const rawLooksLikeDescriptor = typeof raw.type === "string"
      || typeof raw.name === "string"
      || typeof raw.description === "string"
      || "tools" in raw
      || "parameters" in raw
      || "input_schema" in raw
      || "inputSchema" in raw
      || "schema" in raw
      || "format" in raw;
    if (!rawLooksLikeDescriptor) {
      return [{ type: "namespace", name: key, tools: raw }];
    }
    const entry = { ...raw };
    // Namespace maps use the key as the namespace and retain an explicitly supplied child name.
    // Direct tool maps use the key as the exact callable wire name.
    if (entry.type === "namespace" || "tools" in entry) {
      if (typeof entry.name !== "string" || entry.name.length === 0) entry.name = key;
    } else {
      entry.name = key;
    }
    return [entry];
  });
}

function markToolSpecSource(
  entries: Record<string, unknown>[],
  source: Exclude<NonNullable<CodexTool["source"]>, "declared">,
): Record<string, unknown>[] {
  return entries.map(entry => ({ ...entry, __codexSource: source }));
}

function toolSpecsFromWireContainer(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (isObj(item) && (item.type === "additional_tools" || item.type === "tool_search_output")) {
        return toolContainerEntries(item.tools);
      }
      return isObj(item) ? [item] : [];
    });
  }
  if (isObj(value) && (value.type === "additional_tools" || value.type === "tool_search_output")) {
    return toolContainerEntries(value.tools);
  }
  return toolContainerEntries(value);
}

type CodexToolSource = NonNullable<CodexTool["source"]>;

function toolSource(value: unknown, fallback: CodexToolSource): CodexToolSource {
  return value === "declared" || value === "additional_tools" || value === "tool_search_output"
    ? value
    : fallback;
}

function buildTools(tools: unknown, defaultSource: CodexToolSource = "declared"): CodexTool[] | undefined {
  const entries = toolContainerEntries(tools);
  if (entries.length === 0) return undefined;
  const out: CodexTool[] = [];
  const parametersOf = (t: Record<string, unknown>): Record<string, unknown> => {
    const value = [t.parameters, t.inputSchema, t.input_schema, t.schema]
      .find(candidate => isObj(candidate));
    return (value ?? {}) as Record<string, unknown>;
  };
  const pushFn = (t: Record<string, unknown>, namespace: string | undefined, source: CodexToolSource) => {
    const tool: CodexTool = {
      name: t.name as string,
      description: (t.description as string) ?? "",
      parameters: parametersOf(t),
      source,
    };
    if (t.strict !== undefined) tool.strict = t.strict as boolean;
    if (namespace) tool.namespace = namespace;
    if (t.freeform === true) tool.freeform = true;
    if (t.toolSearch === true) tool.toolSearch = true;
    out.push(tool);
  };
  const pushFreeform = (t: Record<string, unknown>, namespace: string | undefined, source: CodexToolSource) => {
    const tool: CodexTool = {
      name: t.name as string,
      description: (t.description as string) ?? "",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope.",
          },
        },
        required: ["input"],
      },
      freeform: true,
      source,
    };
    if (namespace) tool.namespace = namespace;
    out.push(tool);
  };
  const pushToolSearch = (t: Record<string, unknown>, namespace: string | undefined, source: CodexToolSource) => {
    const tool: CodexTool = {
      name: typeof t.name === "string" && t.name.length > 0 ? t.name : "tool_search",
      description: (t.description as string) ?? "Search for additional tools to load for the next turn.",
      parameters: (parametersOf(t) && Object.keys(parametersOf(t)).length > 0 ? parametersOf(t) : {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for tools to load." },
          limit: { type: "number", description: "Maximum number of tools to return." },
        },
        required: ["query"],
      }) as Record<string, unknown>,
      toolSearch: true,
      source,
    };
    if (namespace) tool.namespace = namespace;
    out.push(tool);
  };
  const append = (
    t: Record<string, unknown>,
    inheritedNamespace?: string,
    inheritedSource: CodexToolSource = defaultSource,
  ): void => {
    const source = toolSource(t.__codexSource, inheritedSource);
    if (t.type === "namespace") {
      const namespace = normalizedToolNamespace(t.name) ?? inheritedNamespace;
      for (const inner of toolContainerEntries(t.tools)) append(inner, namespace, source);
      return;
    }

    const namespace = normalizedToolNamespace(t.namespace) ?? inheritedNamespace;
    if (t.toolSearch === true || t.type === "tool_search") {
      // Client-executed tool discovery — the gateway to deferred tools (subagents, extra MCP tools).
      // Expose as a function so chat models can call it; the bridge relays it as a tool_search_call.
      pushToolSearch(t, namespace, source);
      return;
    }

    const name = typeof t.name === "string" && t.name.length > 0 ? t.name : undefined;
    if (!name) return;
    if (t.freeform === true || t.type === "custom"
      || (isObj(t.format) && t.format.type === "grammar")) {
      // Freeform custom tool (e.g. apply_patch). Chat models can't emit a lark grammar, so expose a
      // function with a single string `input` carrying the raw tool body; the bridge relays the model's
      // call back as a custom_tool_call (Codex's freeform handler rejects a function_call → fatal abort).
      pushFreeform(t, namespace, source);
    } else if (t.type === "function") {
      pushFn(t, namespace, source);
    } else if (t.type !== "web_search" && t.type !== "image_generation") {
      // Any other named tool (for example a native computer-use tool type this parser does not
      // model) is client-executed. Pass it through as a function so the routed model can call it
      // naturally and the bridge can relay it as a function_call.
      pushFn(t, namespace, source);
    }
    // Only the OpenAI-hosted server-side tools (web_search, image_generation) are intentionally
    // dropped — they're executed by OpenAI and can't be relayed to a routed chat model.
  };
  for (const t of entries) append(t);
  return out.length > 0 ? out : undefined;
}

function ensureAssistantPlaceholder(messages: CodexMessage[], modelId: string, now: number): CodexAssistantMessage {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") return last;
  const placeholder: CodexAssistantMessage = { role: "assistant", content: [], model: modelId, timestamp: now };
  messages.push(placeholder);
  return placeholder;
}

/**
 * Tool-call output content. Preserves images (e.g. Codex `view_image` returns
 * `input_image` items): returns content parts when any image is present, else a plain joined string.
 * Never inlines an image_url as text (that would explode the token count).
 */
function outputToToolResultContent(
  output: string | unknown[] | undefined,
  omitImages = false,
): string | CodexContentPart[] {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  const parts: CodexContentPart[] = [];
  let hasImage = false;
  for (const raw of output) {
    if (!isObj(raw)) continue;
    if (raw.type === "output_text" || raw.type === "text" || raw.type === "input_text") {
      if (typeof raw.text === "string") parts.push({ type: "text", text: raw.text });
    } else if (raw.type === "refusal" && typeof raw.refusal === "string") {
      parts.push({ type: "text", text: `[refusal: ${raw.refusal}]` });
    } else if (raw.type === "input_image" && typeof raw.image_url === "string") {
      if (omitImages) {
        if (isOnePixelPngDataUrl(raw.image_url)) continue;
        parts.push({ type: "text", text: PRE_COMPACTION_IMAGE_NOTE });
      } else {
        parts.push({ type: "image", imageUrl: raw.image_url, ...(typeof raw.detail === "string" ? { detail: normalizeImageDetail(raw.detail) } : {}) });
        hasImage = true;
      }
    } else if (raw.type === "encrypted_content") {
      // codex-rs FunctionCallOutputContentItem::EncryptedContent — opaque to routed models.
      parts.push({ type: "text", text: "[encrypted content omitted]" });
    }
  }
  if (!hasImage) return parts.map(p => (p.type === "text" ? p.text : "")).join("");
  return parts;
}

/**
 * codex-rs ImageDetail allows "original", but chat-completions providers only accept
 * auto|low|high on image_url.detail — degrade "original" to "high" (the codex default).
 */
function normalizeImageDetail(detail: string): string {
  return detail === "original" ? "high" : detail;
}

function findToolById(messages: CodexMessage[], callId: string): { name: string; namespace?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type === "toolCall" && part.id === callId) return { name: part.name, namespace: part.namespace };
    }
  }
  return { name: "" };
}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function nativeMessageSource(
  value: unknown,
  inputIndex: number,
): { _sourceInputIndex: number; _sourceItemId?: string; _sourceTurnId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { _sourceInputIndex: inputIndex };
  const item = value as Record<string, unknown>;
  const metadata = item.internal_chat_message_metadata_passthrough;
  const turnId = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as { turn_id?: unknown }).turn_id
    : undefined;
  return {
    _sourceInputIndex: inputIndex,
    ...(typeof item.id === "string" && item.id.length > 0 ? { _sourceItemId: item.id } : {}),
    ...(typeof turnId === "string" && turnId.length > 0 ? { _sourceTurnId: turnId } : {}),
  };
}

function attachNativeMessageSource<T extends CodexUserMessage | CodexAgentMessage>(
  message: T,
  value: unknown,
  inputIndex: number,
): T {
  const source = nativeMessageSource(value, inputIndex);
  for (const [key, fieldValue] of Object.entries(source)) {
    Object.defineProperty(message, key, {
      value: fieldValue,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return message;
}

export function parseRequest(body: unknown): CodexParsedRequest {
  const replayedInputPrefixLength = previousResponseReplayPrefixLength(body);
  // Zod deliberately normalizes public Responses items and strips unknown passthrough fields from
  // ordinary user messages. Native provenance metadata lives on the untouched wire item, so keep a
  // positional view of the raw input for authoritative classifications such as goal.internal_context.
  const rawInput = isObj(body) && Array.isArray(body.input) ? body.input : undefined;
  const parsed = responsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`responses parse error: ${parsed.error.message}`);
  }
  const data = parsed.data;
  const now = Date.now();
  const messages: CodexMessage[] = [];
  const systemPrompt: string[] = [];
  // Responses reasoning siblings belong to the following assistant, including across call items.
  // Keep them off the message list until that assistant arrives; turn boundaries clear the array.
  const pendingReasoning: Array<{ part: CodexThinkingContent; envelopeSigned: boolean }> = [];
  // Assistant placeholder that folds pending reasoning into the same turn before tool calls.
  const assistantHolderWithReasoning = (): CodexAssistantMessage => {
    const holder = ensureAssistantPlaceholder(messages, data.model, now);
    if (pendingReasoning.length > 0) {
      holder.content.push(...pendingReasoning.map(entry => entry.part));
      pendingReasoning.length = 0;
    }
    return holder;
  };
  // Tool specs surfaced by a prior tool_search (deferred tools, e.g. subagents). Codex does not
  // re-list these in `tools`, but chat models can only call listed tools — so we re-inject them.
  const loadedToolSpecs: unknown[] = [];
  // Remote compaction v2: the input tail carries `{type:"compaction_trigger"}` and Codex expects a
  // synthetic `{type:"compaction"}` output item (src/responses/compaction.ts). Flagged for the server.
  let compactionRequest = false;
  let opaqueMultiAgentV2Payload = false;

  if (typeof data.instructions === "string" && data.instructions.length > 0) {
    systemPrompt.push(data.instructions);
  }

  if (typeof data.input === "string") {
    messages.push({ role: "user", content: data.input, timestamp: now });
  } else if (data.input) {
    const compactionBoundaryIndex = latestCompactionBoundaryIndex(data.input);
    for (let itemIndex = 0; itemIndex < data.input.length; itemIndex += 1) {
      const item = data.input[itemIndex]!;
      // A completed compaction checkpoint semantically replaces the earlier visual history. Keep
      // the canonical native items for provenance and textual replay, but do not physically upload
      // their images into each fresh ChatGPT Temporary Chat. Only images introduced after the most
      // recent checkpoint are new browser attachments.
      const omitHistoricalImages = compactionBoundaryIndex >= 0 && itemIndex < compactionBoundaryIndex;
      const effectiveType = (item as { type?: string }).type ?? ("role" in item ? "message" : undefined);

      if (effectiveType === "compaction_trigger") {
        compactionRequest = true;
        continue;
      }

      if (effectiveType === "additional_tools") {
        // Codex Desktop responses_lite WS path: tools ride INSIDE input as an
        // `additional_tools` item ({type, role, tools:[...]}) instead of body.tools.
        // Same spec wire shapes (function/namespace/custom/tool_search) — collect and
        // merge through the exact buildTools path so surface detection (collabSurface)
        // and chat-model tool listing see them. The item itself never becomes a message;
        // the native passthrough keeps it verbatim in _rawBody.
        const at = item as { tools?: unknown };
        loadedToolSpecs.push(...markToolSpecSource(toolSpecsFromWireContainer(at.tools), "additional_tools"));
        continue;
      }

      if (effectiveType === "compaction" || effectiveType === "compaction_summary" || effectiveType === "context_compaction") {
        // A stored summary from a previous compaction. Decode our ocx1 envelope into plain text so
        // the routed model keeps the compacted context; real OpenAI-encrypted blobs degrade to a note.
        // `context_compaction` (encrypted_content optional) is codex-rs's local-compaction marker;
        // with no payload it is a pure marker (the summary follows as its own user message), so it
        // is dropped silently. It must not flag `_compactionRequest`.
        const encrypted = (item as { encrypted_content?: unknown }).encrypted_content;
        if (effectiveType === "context_compaction" && typeof encrypted !== "string") continue;
        pendingReasoning.length = 0;
        messages.push({
          role: "user",
          content: compactionItemToText(typeof encrypted === "string" ? encrypted : undefined),
          timestamp: now,
        });
        continue;
      }

      if (effectiveType === "agent_message") {
        const agentMessage = item as {
          author?: string;
          recipient?: string;
          content?: unknown;
        };

        if (containsOpaqueEncryptedContent(agentMessage.content)) {
          opaqueMultiAgentV2Payload = true;
        }

        const content = inputContentParts(
          agentMessage.content as unknown[] | string | undefined,
          omitHistoricalImages,
        );

        // An agent_message is external input delivered to the parent agent. Keep its distinct
        // role and routing metadata so Web history remains semantically equivalent to Responses.
        pendingReasoning.length = 0;
        const message = attachNativeMessageSource<CodexAgentMessage>({
          role: "agentMessage",
          ...(typeof agentMessage.author === "string" ? { author: agentMessage.author } : {}),
          ...(typeof agentMessage.recipient === "string" ? { recipient: agentMessage.recipient } : {}),
          content,
          timestamp: now,
        }, rawInput?.[itemIndex] ?? item, itemIndex);
        messages.push(message);

        continue;
      }

      if (effectiveType === "message") {
        const msg = item as {
          role?: string;
          content?: unknown;
          phase?: "commentary" | "final_answer";
          internal_chat_message_metadata_passthrough?: { content_item_kinds?: string[] };
        };
        switch (msg.role) {
          case "system": {
            pendingReasoning.length = 0;
            const text = inputContentParts(msg.content as unknown[] | string | undefined, omitHistoricalImages);
            const flat = typeof text === "string" ? text : text.map(p => (p.type === "text" ? p.text : "")).join("");
            if (flat.length > 0) systemPrompt.push(flat);
            break;
          }
          case "user": {
            // `/goal` is emitted by native Codex as a user-role runtime item. Keep its exact wire
            // metadata in `_rawBody` for lineage validation, but never serialize its body into the
            // ChatGPT task envelope as if a human had written it. Mixed/unknown native kinds remain
            // ordinary user input and therefore fail closed instead of being dropped by text shape.
            if (isNativeGoalContextItem(rawInput?.[itemIndex] ?? item)) {
              pendingReasoning.length = 0;
              break;
            }
            pendingReasoning.length = 0;
            const content = inputContentParts(msg.content as unknown[] | string | undefined, omitHistoricalImages);
            const kinds = msg.internal_chat_message_metadata_passthrough?.content_item_kinds;
            const selectedSkill = kinds?.length === 1 && kinds[0] === "skills.selected_skill_instructions";
            messages.push(attachNativeMessageSource<CodexUserMessage>({
              role: "user",
              ...(selectedSkill ? { origin: "codex_skill" as const } : {}),
              content,
              timestamp: now,
            }, rawInput?.[itemIndex] ?? item, itemIndex));
            break;
          }
          case "developer": {
            pendingReasoning.length = 0;
            const content = inputContentParts(msg.content as unknown[] | string | undefined, omitHistoricalImages);
            messages.push({ role: "developer", content, timestamp: now });
            break;
          }
          case "assistant": {
            const parts = outputTextOf(msg.content as unknown[] | string | undefined);
            messages.push({
              role: "assistant",
              content: pendingReasoning.length > 0
                ? [...pendingReasoning.map(entry => entry.part), ...parts]
                : parts,
              ...(msg.phase ? { phase: msg.phase } : {}),
              model: data.model,
              timestamp: now,
            });
            pendingReasoning.length = 0;
            break;
          }
        }
        continue;
      }

      if (effectiveType === "reasoning") {
        const reasoning = item as { id?: string; summary?: { text: string }[]; content?: { text: string }[]; encrypted_content?: string };
        const fromSummary = (reasoning.summary ?? []).map(c => c.text).join("");
        const text = fromSummary || (reasoning.content ?? []).map(c => c.text).join("");
        const envelope = typeof reasoning.encrypted_content === "string"
          ? decodeReasoningEnvelope(reasoning.encrypted_content)
          : null;
        const thinkingText = envelope?.txt || text;

        // Native/non-ocxr1 encrypted-only reasoning is opaque here. Do not create a detached
        // assistant turn or invent replayable plaintext/signatures from the encrypted payload.
        if (thinkingText.length > 0) {
          const part: CodexThinkingContent = {
            type: "thinking",
            thinking: thinkingText,
            signature: envelope?.sig ?? JSON.stringify(reasoning),
            ...(envelope?.red ? { redacted: envelope.red } : {}),
            ...(reasoning.id ? { itemId: reasoning.id } : {}),
          };
          const envelopeSigned = typeof envelope?.sig === "string";
          const previous = pendingReasoning[pendingReasoning.length - 1];

          if (!envelopeSigned && previous && !previous.envelopeSigned) {
            previous.part = {
              ...part,
              thinking: `${previous.part.thinking}\n${part.thinking}`,
            };
          } else {
            pendingReasoning.push({ part, envelopeSigned });
          }
        }
        continue;
      }

      if (effectiveType === "function_call") {
        const call = item as { id?: string; call_id: string; name: string; arguments?: string; namespace?: string };
        // Tolerate empty/non-JSON arguments (e.g. a no-arg tool call serialized as "") instead of
        // throwing — a single poisoned history item would otherwise 400 every subsequent turn.
        let args: Record<string, unknown> = {};
        const rawArgs = call.arguments?.trim();
        if (rawArgs) {
          try {
            const parsed: unknown = JSON.parse(rawArgs);
            if (isObj(parsed)) args = parsed;
          } catch {
            console.warn(`[parser] function_call ${call.call_id} has non-JSON arguments; defaulting to {}`);
          }
        }
        // Do NOT map Responses item `id` (fc_/ctc_/…) onto `thoughtSignature`. That field is
        // reserved for genuine opaque thought tokens. A Responses item id is not such a token;
        // continuity comes from the in-process replay cache and any real stored signature.
        const toolCall: CodexToolCall = {
          type: "toolCall", id: call.call_id, name: call.name, arguments: args,
          ...(call.namespace ? { namespace: call.namespace } : {}),
        };
        assistantHolderWithReasoning().content.push(toolCall);
        continue;
      }

      if (effectiveType === "custom_tool_call") {
        const call = item as { id?: string; call_id: string; name: string; input: string };
        const toolCall: CodexToolCall = {
          type: "toolCall", id: call.call_id, name: call.name,
          arguments: { input: call.input ?? "" },
        };
        assistantHolderWithReasoning().content.push(toolCall);
        continue;
      }

      if (effectiveType === "local_shell_call") {
        // codex-rs LocalShellCall replay: pair it as an assistant toolCall so the subsequent
        // function_call_output (same call_id) doesn't become an orphaned tool result.
        const call = item as { id?: string; call_id?: string; action?: { type?: string; command?: string[] } };
        const callId = call.call_id ?? call.id;
        if (callId) {
          const command = Array.isArray(call.action?.command) ? call.action.command : [];
          assistantHolderWithReasoning().content.push({
            type: "toolCall", id: callId, name: "shell",
            arguments: command.length > 0 ? { command } : {},
          });
        }
        continue;
      }

      if (effectiveType === "web_search_call") {
        // Replayed hosted web-search evidence has no paired result payload that routed providers can
        // consume. Keep it out of assistant-visible text so the model cannot echo it as a fake result.
        pendingReasoning.length = 0;
        continue;
      }

      if (effectiveType === "tool_search_call") {
        // Preserve the model's prior tool_search call as an assistant tool call so multi-turn
        // history stays complete (otherwise the model re-issues tool_search forever).
        const call = item as { id?: string; call_id?: string; arguments?: unknown };
        const callId = call.call_id ?? call.id ?? "";
        assistantHolderWithReasoning().content.push({
          type: "toolCall", id: callId, name: "tool_search",
          arguments: isObj(call.arguments) ? call.arguments : {},
        });
        continue;
      }

      if (effectiveType === "tool_search_output") {
        pendingReasoning.length = 0;
        // Pair the tool_search call with its result so the model sees what was loaded.
        const out = item as { call_id?: string; status?: string; tools?: unknown };
        const specs = toolSpecsFromWireContainer(out.tools);
        loadedToolSpecs.push(...markToolSpecSource(specs, "tool_search_output"));
        // List the EXACT wire names the model must call (flattened for namespaced specs), matching
        // how buildTools exposes them — otherwise the model guesses wrong names (e.g. the bare namespace).
        const wireNames = (buildTools(specs) ?? []).map(tool => namespacedToolName(tool.namespace, tool.name));
        const failed = typeof out.status === "string" && out.status !== "completed" && out.status !== "success";
        messages.push({
          role: "toolResult", toolCallId: out.call_id ?? "", toolName: "tool_search",
          content: failed && wireNames.length === 0
            ? `Tool search failed (status: ${out.status}).`
            : wireNames.length
              ? `Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: ${wireNames.join(", ")}.`
              : "Tool search returned no tools.",
          isError: failed && wireNames.length === 0, timestamp: now,
        });
        continue;
      }

      if (effectiveType === "function_call_output") {
        pendingReasoning.length = 0;
        const output = item as { call_id: string; output?: string | unknown[] };
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: toolInfo.name, toolNamespace: toolInfo.namespace,
          content: outputToToolResultContent(output.output, omitHistoricalImages), isError: false, timestamp: now,
        });
        continue;
      }

      if (effectiveType === "custom_tool_call_output") {
        pendingReasoning.length = 0;
        const output = item as { call_id: string; output: string | unknown[] };
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: toolInfo.name, toolNamespace: toolInfo.namespace,
          // Same payload shape as function_call_output (codex-rs FunctionCallOutputPayload):
          // string or content items — normalize arrays instead of leaking raw wire blocks.
          content: outputToToolResultContent(output.output, omitHistoricalImages), isError: false, timestamp: now,
        });
      }
    }
  }

  // Preserve clients that send deferred tool declarations as top-level Responses Lite fields.
  // They are merged through the same exact flattening and provenance path as input items.
  const topLevelBody = data as typeof data & { additional_tools?: unknown; tool_search_output?: unknown };
  if (topLevelBody.additional_tools !== undefined) {
    loadedToolSpecs.push(...markToolSpecSource(
      toolSpecsFromWireContainer(topLevelBody.additional_tools),
      "additional_tools",
    ));
  }
  if (topLevelBody.tool_search_output !== undefined) {
    loadedToolSpecs.push(...markToolSpecSource(
      toolSpecsFromWireContainer(topLevelBody.tool_search_output),
      "tool_search_output",
    ));
  }

  const declaredTools = buildTools(data.tools) ?? [];
  const loadedTools = buildTools(loadedToolSpecs) ?? [];
  const seenTools = new Set<string>();
  const mergedTools = [...declaredTools, ...loadedTools]
    .filter(t => {
      const k = namespacedToolName(t.namespace, t.name);
      if (seenTools.has(k)) return false;
      seenTools.add(k);
      return true;
    });
  const context: CodexContext = {
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    messages,
    ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
  };

  const options: CodexRequestOptions = {};
  if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
  if (data.temperature !== undefined) options.temperature = data.temperature;
  if (data.top_p !== undefined) options.topP = data.top_p;
  if (data.stop !== undefined && data.stop !== null) {
    options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
  }
  const tc = mapToolChoice(data.tool_choice);
  if (tc !== undefined) options.toolChoice = tc;
  if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
  // Upstream codex-rs converts "ultra" to "max" at the inference boundary (core/src/client.rs
  // `reasoning_effort_for_request`), so current clients never send it — but a catalog that
  // advertises ultra plus an older/direct caller can. Degrade it to max like upstream instead of
  // silently dropping reasoning altogether.
  const requestedEffort = data.reasoning?.effort === "ultra" ? "max" : data.reasoning?.effort;
  if (requestedEffort && REASONING_EFFORTS.has(requestedEffort)) {
    options.reasoning = requestedEffort;
  }
  const summaryMode = data.reasoning?.summary;
  if (!summaryMode || summaryMode === "none") options.hideThinkingSummary = true;
  if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
  if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
  if (data.service_tier !== undefined) options.serviceTier = data.service_tier;
  Object.assign(options, parseTextControls(data.text));
  if (data.prompt_cache_key !== undefined) options.promptCacheKey = data.prompt_cache_key;

  return {
    modelId: data.model,
    ...(data.previous_response_id ? { previousResponseId: data.previous_response_id } : {}),
    context,
    stream: data.stream === true,
    options,
    _rawBody: body,
    ...(replayedInputPrefixLength > 0 ? { _replayPrefixLen: replayedInputPrefixLength } : {}),
    ...(compactionRequest ? { _compactionRequest: true } : {}),
    ...(opaqueMultiAgentV2Payload ? { _opaqueMultiAgentV2Payload: true } : {}),
  };
}
