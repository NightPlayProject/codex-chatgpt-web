import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { VERSION } from "../../version";
import type { ChatGptTurnEnvironment } from "./environment";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import {
  buildChatGptToolCapabilityReport,
  CHATGPT_TOOL_SURFACE_IDS,
  chatGptToolSurfaceForTool,
  chatGptUnavailableToolMessage,
  type ChatGptToolSurfaceId,
} from "./tool-capabilities";
import { callTurnBroker, TurnBrokerTimeoutError, type BrokerToolResult } from "./turn-broker";
import { observeMcpToolCalls } from "./mcp-observation";

interface ClaimedTurn {
  bindingId: string;
  activityId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

export type ChatGptMcpContract = "native" | "safe";

const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start",
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_capabilities",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_turn_complete",
]);

const GATEWAY_AGENT_WAIT_TOOL_NAMES = new Set([
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
  "collaboration__wait_agent",
]);

const turnTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
// Match Codex's default wait interval while returning before the MCP invocation deadline.
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 30_000;
const AGENT_WAIT_TRANSPORT_RULE = `ChatGPT Web transport rule: wait for exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS / 1_000} seconds per call, matching the Codex default, then release the MCP channel so spawned Web agents can use their own tools. A wait timeout is not task completion; check agent progress and wait again if needed. Keep the native tool's declared arguments.`;
// The OpenAI tunnel currently owns a two-minute command-response deadline. Leave a small margin
// for the MCP response frame while giving the native Codex consumer time to reconnect after a
// transient browser/Responses disconnect.
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 110_000;

const ZERO_RISK_MCP_INSTRUCTIONS = [
  "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id in its request block.",
  "Use that request_id with the Codex tools needed for the task. Direct and deferred shell, process, browser/computer, MCP, connector/app, and subagent tools use the same bridge.",
  "Call codex_tool_capabilities before declaring a surface unavailable. If the required capability is not listed as a direct tool, use an outer Codex tool_search entry when it is advertised by the capability report, invoking its exact wire_name through codex_tool_call; otherwise call codex_tool_inventory with a focused query and include_schema=true, then call the exact returned wire_name with codex_tool_call. Use arguments for structured tools and input for freeform tools; do not guess or rename tool names.",
  "If codex_tool_capabilities is absent from the connector, refresh or reload the Codex Web GPT connector in ChatGPT before starting a new turn.",
  "When the task is finished, send the complete answer with codex_turn_complete.",
  "If a tool returns an error, report that error instead of changing the request_id.",
].join(" ");

function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: turnTokenSchema };
}

function turnReference(contract: ChatGptMcpContract, input: object): string {
  const key = contract === "safe" ? "request_id" : "turn_token";
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

interface McpRequestExtra {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
}

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function canonicalInvocationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInvocationValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalInvocationValue(item)]),
    );
  }
  return value;
}

function mcpInvocationKey(
  extra: McpRequestExtra,
  bindingId: string,
  tool: CodexTool,
  payload: { arguments?: Record<string, unknown>; input?: string },
): string {
  // MCP request ids are stable across a transport retry, but a connector can reuse an id after
  // a response has completed. Include the bound turn, exact wire tool, call mode, and canonical
  // payload so a reused id cannot replay a different native action while preserving idempotent
  // replay for the same lost handoff.
  const identity = canonicalInvocationValue({
    sessionId: extra.sessionId ?? "",
    requestId: String(extra.requestId),
    bindingId,
    wireName: wireName(tool),
    freeform: tool.freeform === true,
    payload: tool.freeform === true
      ? { input: payload.input ?? "" }
      : { arguments: payload.arguments ?? {} },
  });
  // Keep the key independent of the short-lived MCP server process. ChatGPT may recreate the
  // stdio connector while the outer Codex turn and broker binding are still alive; a retry after
  // that reconnect must be able to receive the already-completed native result.
  return `mcp:${scopeHash(JSON.stringify(identity))}`;
}

function requestScopeSummary(extra: McpRequestExtra): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result<T extends object>(value: T, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

function afterSafeStart(contract: ChatGptMcpContract, description: string): string {
  return contract === "safe"
    ? `For a Zero Risk request connected by codex_turn_start. ${description}`
    : description;
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

const GATEWAY_TOOL_NAME_MAX_LENGTH = 1_000;
const GATEWAY_FORBIDDEN_TOOL_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function gatewayToolNameIsValid(name: string): boolean {
  // Tool names are property keys supplied by the current native harness. Keep the exact key
  // instead of rewriting punctuation (MCP names are not required to be JavaScript identifiers),
  // while rejecting control characters and prototype keys before bracket access is generated.
  return name.length > 0
    && name.length <= GATEWAY_TOOL_NAME_MAX_LENGTH
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)
    && !GATEWAY_FORBIDDEN_TOOL_NAMES.has(name);
}

function safeVisibleTools(environment: ChatGptTurnEnvironment, contract: ChatGptMcpContract): CodexTool[] {
  if (contract === "native") return environment.tools;
  const bridgeNamespaces = new Set(environment.tools
    .filter(tool => tool.namespace && BRIDGE_TOOL_NAMES.has(tool.name))
    .map(tool => tool.namespace!));
  return environment.tools.filter(tool => (
    wireName(tool) !== CODEX_COMPACTION_CONTROL_WIRE_NAME
    && !BRIDGE_TOOL_NAMES.has(tool.name)
    // Zero Risk does not expose model-authored JavaScript. Automatic Full mode keeps the native
    // Codex exec surface and applies its transport guard at invocation time below.
    && (tool.namespace !== undefined || tool.name !== "exec")
    && (!tool.namespace || !bridgeNamespaces.has(tool.namespace))
  ));
}

function isAgentWaitTool(tool: CodexTool): boolean {
  return isGatewayAgentWaitTool(wireName(tool));
}

function isGatewayAgentWaitTool(name: string): boolean {
  return GATEWAY_AGENT_WAIT_TOOL_NAMES.has(name);
}

function browserToolDescription(tool: CodexTool): string {
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.`;
  }
  return tool.description;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  // The cloned native schema must not advertise a default that contradicts our required interval.
  delete timeout.default;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout,
        type: "number",
        const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: `Required transport-safe polling interval. Use exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS}; a timed-out wait does not mean the agents have finished.`,
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function assertGatewayToolArguments(name: string, args: Record<string, unknown>): void {
  if (!isGatewayAgentWaitTool(name)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

export function chatGptMcpInvocationTimeout(
  environment: ChatGptTurnEnvironment & { expiresAt?: number },
  now = Date.now(),
): number {
  const remaining = environment.expiresAt === undefined
    ? CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS
    : Math.max(1, environment.expiresAt - now);
  return Math.min(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, remaining);
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function toolCapabilityReport(
  bound: ChatGptTurnEnvironment,
  contract: ChatGptMcpContract,
) {
  const visibleTools = safeVisibleTools(bound, contract);
  return buildChatGptToolCapabilityReport({
    outerTools: bound.tools,
    visibleTools,
    gateway: execGateway(bound),
    contract,
  });
}

interface GatewayToolDescriptor {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface GatewayToolCatalogPage {
  tools: GatewayToolDescriptor[];
  total: number;
}

function gatewayToolDescription(tool: GatewayToolDescriptor): string {
  if (!isGatewayAgentWaitTool(tool.name)) return tool.description;
  return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
}

const GENERIC_GATEWAY_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: true,
  description: "Pass the exact structured arguments declared in this tool's description. For a declared freeform tool, use codex_tool_call.input instead.",
} satisfies Record<string, unknown>;

function withGatewayAgentWaitParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const cloned = structuredClone(parameters);
  const properties = cloned.properties && typeof cloned.properties === "object" && !Array.isArray(cloned.properties)
    ? cloned.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  delete timeout.default;
  const required = Array.isArray(cloned.required)
    ? cloned.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...cloned,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout,
        type: "number",
        const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: `Required transport-safe polling interval. Use exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS}; a timed-out wait does not mean the agents have finished.`,
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

function gatewayToolParameters(tool: GatewayToolDescriptor): Record<string, unknown> {
  const parameters = tool.parameters ?? GENERIC_GATEWAY_TOOL_PARAMETERS;
  return isGatewayAgentWaitTool(tool.name)
    ? withGatewayAgentWaitParameters(parameters)
    : parameters;
}

function gatewayToolCatalogProgram(options: {
  query?: string;
  offset: number;
  limit: number;
  excludedNames: string[];
  surface?: ChatGptToolSurfaceId;
}): string {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return [
    `const excludedNames = new Set(${JSON.stringify(options.excludedNames)});`,
    `const needle = ${JSON.stringify(needle)};`,
    `const requestedSurface = ${JSON.stringify(options.surface ?? null)};`,
    "const surfaceOf = (name, description) => {",
    "  const value = String(name ?? '') + '\\n' + String(description ?? '');",
    "  if (/(computer[_-]?use|computer-use|desktop|screen|screenshot|get[_-]?app[_-]?state|mouse|keyboard|click|double[_-]?click|scroll|drag|keypress|type[_-]?text|open[_-]?app|close[_-]?app|window)/i.test(value)) return 'computer';",
    "  if (/(browser|web[_-]?run|search[_-]?query|open[_-]?url|navigate|page|tab|website|fetch[_-]?url)/i.test(value)) return 'browser';",
    "  if (/(agent|subagent|multi[_-]?agent|collaboration|spawn[_-]?agent|send[_-]?message|wait[_-]?agent)/i.test(value)) return 'agents';",
    "  if (/(^|[\\n_:/-])(exec|exec[_-]?command|shell[_-]?command|terminal|process|kill[_-]?process|write[_-]?stdin|run[_-]?command)([\\n_:/-]|$)/i.test(value)) return 'execution';",
    "  if (/(apply[_-]?patch|read[_-]?file|write[_-]?file|file|filesystem|directory|path|view[_-]?image|image)/i.test(value)) return 'filesystem';",
    "  if (/(tool[_-]?search|tool[_-]?inventory|discover)/i.test(value)) return 'discovery';",
    "  if (/(^mcp(?:__|[_:/-])|\\bmcp\\b|connector|plugin|app)/i.test(value)) return 'mcp';",
    "  return 'other';",
    "};",
    "const visibleName = name => {",
    `  return typeof name === "string" && name.length > 0 && name.length <= ${GATEWAY_TOOL_NAME_MAX_LENGTH} && !/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/.test(name) && !${JSON.stringify([...GATEWAY_FORBIDDEN_TOOL_NAMES])}.includes(name) && !excludedNames.has(name);`,
    "};",
    "const entries = new Map();",
    "const isObject = value => value !== null && typeof value === \"object\" && !Array.isArray(value);",
    "const descriptorLike = value => isObject(value) && (typeof value.type === \"string\" || typeof value.name === \"string\" || typeof value.description === \"string\" || \"parameters\" in value || \"input_schema\" in value || \"inputSchema\" in value || \"schema\" in value || \"format\" in value);",
    "const addEntry = (entry, fallbackName, prefix = \"\") => {",
    "  const ownName = typeof entry === \"string\" ? entry : isObject(entry) && typeof entry.name === \"string\" ? entry.name : fallbackName;",
    "  const explicitNamespace = isObject(entry) && typeof entry.namespace === \"string\" ? entry.namespace : \"\";",
    "  const name = explicitNamespace ? explicitNamespace + \"__\" + ownName : prefix ? (ownName?.startsWith(prefix + \"__\") ? ownName : prefix + \"__\" + ownName) : ownName;",
    "  if (!visibleName(name) || entries.has(name)) return;",
    "  const description = isObject(entry) && typeof entry.description === \"string\" ? entry.description : \"\";",
    "  const parameters = isObject(entry) ? [entry.parameters, entry.inputSchema, entry.input_schema, entry.schema].find(value => value && typeof value === \"object\" && !Array.isArray(value)) : undefined;",
    "  entries.set(name, { name, description, ...(parameters ? { parameters } : {}) });",
    "};",
    "const flatten = (value, prefix = \"\") => {",
    "  if (Array.isArray(value)) {",
    "    for (const entry of value) {",
    "      if (isObject(entry) && (entry.type === \"namespace\" || \"tools\" in entry)) flatten(entry.tools, typeof entry.name === \"string\" ? entry.name : prefix);",
    "      else addEntry(entry, undefined, prefix);",
    "    }",
    "    return;",
    "  }",
    "  if (!isObject(value)) return;",
    "  if (value.type === \"namespace\" || (\"tools\" in value && !descriptorLike(value))) { flatten(value.tools, typeof value.name === \"string\" ? value.name : prefix); return; }",
    "  for (const key of Reflect.ownKeys(value)) {",
    "    if (typeof key !== \"string\") continue;",
    "    const child = Reflect.get(value, key, value);",
    "    if (isObject(child) && (child.type === \"namespace\" || \"tools\" in child)) { flatten(child.tools, typeof child.name === \"string\" ? child.name : (prefix ? prefix + \"__\" + key : key)); continue; }",
    "    if (isObject(child) && !descriptorLike(child)) { flatten(child, prefix ? prefix + \"__\" + key : key); continue; }",
    "    addEntry(child, key, prefix);",
    "  }",
    "};",
    "const suppliedRegistry = typeof ALL_TOOLS !== \"undefined\" ? ALL_TOOLS : undefined;",
    "try { flatten(suppliedRegistry); } catch { /* registry enumeration is optional */ }",
    "try { flatten(tools); } catch { /* callable properties remain directly addressable */ }",
    "const matches = [...entries.values()]",
    "  .filter(tool => (!needle || (tool.name + \"\\n\" + tool.description).toLowerCase().includes(needle)) && (!requestedSurface || surfaceOf(tool.name, tool.description) === requestedSurface));",
    `const page = matches.slice(${options.offset}, ${options.offset + options.limit});`,
    "text(JSON.stringify({ tools: page, total: matches.length }));",
  ].join("\n");
}

function gatewayToolCatalogPage(response: {
  content: unknown[];
  isError?: boolean;
}, excludedNames: ReadonlySet<string>): GatewayToolCatalogPage {
  const textBlocks = response.content
    .map(item => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined)
    .filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text as string);
  if (response.isError) {
    throw new Error(`Native nested tool inventory failed: ${textBlocks.join("\n") || "unknown error"}`);
  }
  if (textBlocks.length !== 1) {
    throw new Error("Native nested tool inventory returned an invalid text response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlocks[0]!);
  } catch {
    throw new Error("Native nested tool inventory returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native nested tool inventory returned an invalid catalog");
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(catalog.total) || (catalog.total as number) < 0 || !Array.isArray(catalog.tools)) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const tools = catalog.tools.map((value): GatewayToolDescriptor => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native nested tool inventory returned an invalid tool entry");
    }
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string"
      || typeof tool.description !== "string"
      || !gatewayToolNameIsValid(tool.name)
      || excludedNames.has(tool.name)) {
      throw new Error("Native nested tool inventory returned an invalid tool descriptor");
    }
    if (tool.parameters !== undefined
      && (tool.parameters === null || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))) {
      throw new Error("Native nested tool inventory returned an invalid tool schema");
    }
    return {
      name: tool.name,
      description: tool.description,
      ...(tool.parameters !== undefined ? { parameters: tool.parameters as Record<string, unknown> } : {}),
    };
  });
  return { tools, total: catalog.total as number };
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  excludedNames: string[],
): string {
  if (!gatewayToolNameIsValid(nestedToolName) || excludedNames.includes(nestedToolName)) {
    throw new Error(`Codex nested tool is not available in this turn: ${nestedToolName}`);
  }
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    `const nestedToolName = ${JSON.stringify(nestedToolName)};`,
    `const excludedNames = new Set(${JSON.stringify(excludedNames)});`,
    "if (excludedNames.has(nestedToolName)) throw new Error(\"Native nested tool is not callable through the structured gateway\");",
    "const isObject = value => value !== null && typeof value === \"object\" && !Array.isArray(value);",
    "const descriptorLike = value => isObject(value) && (typeof value.type === \"string\" || typeof value.name === \"string\" || typeof value.description === \"string\" || \"parameters\" in value || \"input_schema\" in value || \"inputSchema\" in value || \"schema\" in value || \"format\" in value);",
    "const registryNames = new Set();",
    "const paths = new Map();",
    "const addEntry = (entry, fallbackName, prefix = \"\", path = []) => {",
    "  const ownName = typeof entry === \"string\" ? entry : isObject(entry) && typeof entry.name === \"string\" ? entry.name : fallbackName;",
    "  const explicitNamespace = isObject(entry) && typeof entry.namespace === \"string\" ? entry.namespace : \"\";",
    "  const name = explicitNamespace ? explicitNamespace + \"__\" + ownName : prefix ? (ownName?.startsWith(prefix + \"__\") ? ownName : prefix + \"__\" + ownName) : ownName;",
    "  if (typeof name !== \"string\" || name.length === 0) return;",
    "  registryNames.add(name);",
    "  const candidate = path.length > 0 ? path : [name];",
    "  const list = paths.get(name) || [];",
    "  if (!list.some(item => item.length === candidate.length && item.every((part, index) => part === candidate[index]))) list.push(candidate);",
    "  paths.set(name, list);",
    "};",
    "const flatten = (value, prefix = \"\", path = []) => {",
    "  if (Array.isArray(value)) {",
    "    for (const entry of value) {",
    "      if (isObject(entry) && (entry.type === \"namespace\" || \"tools\" in entry)) flatten(entry.tools, typeof entry.name === \"string\" ? entry.name : prefix, path);",
    "      else addEntry(entry, undefined, prefix, path);",
    "    }",
    "    return;",
    "  }",
    "  if (!isObject(value)) return;",
    "  if (value.type === \"namespace\" || (\"tools\" in value && !descriptorLike(value))) { flatten(value.tools, typeof value.name === \"string\" ? value.name : prefix, path); return; }",
    "  for (const key of Reflect.ownKeys(value)) {",
    "    if (typeof key !== \"string\") continue;",
    "    const child = Reflect.get(value, key, value);",
    "    const childPath = [...path, key];",
    "    if (isObject(child) && (child.type === \"namespace\" || \"tools\" in child)) { flatten(child.tools, typeof child.name === \"string\" ? child.name : (prefix ? prefix + \"__\" + key : key), childPath); continue; }",
    "    if (isObject(child) && !descriptorLike(child)) { flatten(child, prefix ? prefix + \"__\" + key : key, childPath); continue; }",
    "    addEntry(child, key, prefix, childPath);",
    "  }",
    "};",
    "const suppliedRegistry = typeof ALL_TOOLS !== \"undefined\" ? ALL_TOOLS : undefined;",
    "try { flatten(suppliedRegistry); } catch { /* registry enumeration is optional */ }",
    "try { flatten(tools); } catch { /* callable properties remain directly addressable */ }",
    "const resolveNative = name => {",
    "  try { const direct = Reflect.get(tools, name, tools); if (typeof direct === \"function\") return { value: direct, owner: tools }; } catch {}",
    "  for (const path of paths.get(name) || []) {",
    "    let owner = tools;",
    "    try { for (const part of path.slice(0, -1)) owner = Reflect.get(owner, part, owner); const value = Reflect.get(owner, path.at(-1), owner); if (typeof value === \"function\") return { value, owner }; } catch {}",
    "  }",
    "  return undefined;",
    "};",
    "if (!registryNames.has(nestedToolName)) { try { if (typeof Reflect.get(tools, nestedToolName, tools) === \"function\") registryNames.add(nestedToolName); } catch {} }",
    "if (!registryNames.has(nestedToolName)) throw new Error(\"Native nested tool is not listed in this turn\");",
    "const resolved = resolveNative(nestedToolName);",
    "if (!resolved) throw new Error(\"Native nested tool is listed but unavailable\");",
    `const result = await Reflect.apply(resolved.value, resolved.owner, [${JSON.stringify(nestedInput)}]);`,
  ]);
}

/**
 * Preserve the native freeform exec surface while applying the same wait_agent deadline contract
 * as direct calls. The model still owns its JavaScript; only the tool registry it receives is a
 * transparent proxy whose native wait functions validate their transport-bound argument before dispatch.
 */
function transportBoundRawExecProgram(input: string, blockedExecName: string): string {
  return [
    "await (async (tools) => {",
    input,
    "})((() => {",
    "  const source = tools;",
    `  const waitNames = new Set(${JSON.stringify([...GATEWAY_AGENT_WAIT_TOOL_NAMES])});`,
    `  const blockedExecName = ${JSON.stringify(blockedExecName)};`,
    `  const pollMs = ${CHATGPT_WEB_AGENT_WAIT_POLL_MS};`,
    "  const isObject = value => value !== null && typeof value === \"object\" && !Array.isArray(value);",
    "  const descriptorLike = value => isObject(value) && (typeof value.type === \"string\" || typeof value.name === \"string\" || typeof value.description === \"string\" || \"parameters\" in value || \"input_schema\" in value || \"inputSchema\" in value || \"schema\" in value || \"format\" in value);",
    "  const registryNames = new Set();",
    "  const paths = new Map();",
    "  const addEntry = (entry, fallbackName, prefix = \"\", path = []) => {",
    "    const ownName = typeof entry === \"string\" ? entry : isObject(entry) && typeof entry.name === \"string\" ? entry.name : fallbackName;",
    "    const explicitNamespace = isObject(entry) && typeof entry.namespace === \"string\" ? entry.namespace : \"\";",
    "    const name = explicitNamespace ? explicitNamespace + \"__\" + ownName : prefix ? (ownName?.startsWith(prefix + \"__\") ? ownName : prefix + \"__\" + ownName) : ownName;",
    "    if (typeof name !== \"string\" || name.length === 0) return;",
    "    registryNames.add(name);",
    "    const candidate = path.length > 0 ? path : [name];",
    "    const list = paths.get(name) || [];",
    "    if (!list.some(item => item.length === candidate.length && item.every((part, index) => part === candidate[index]))) list.push(candidate);",
    "    paths.set(name, list);",
    "  };",
    "  const flatten = (value, prefix = \"\", path = []) => {",
    "    if (Array.isArray(value)) {",
    "      for (const entry of value) {",
    "        if (isObject(entry) && (entry.type === \"namespace\" || \"tools\" in entry)) flatten(entry.tools, typeof entry.name === \"string\" ? entry.name : prefix, path);",
    "        else addEntry(entry, undefined, prefix, path);",
    "      }",
    "      return;",
    "    }",
    "    if (!isObject(value)) return;",
    "    if (value.type === \"namespace\" || (\"tools\" in value && !descriptorLike(value))) { flatten(value.tools, typeof value.name === \"string\" ? value.name : prefix, path); return; }",
    "    for (const key of Reflect.ownKeys(value)) {",
    "      if (typeof key !== \"string\") continue;",
    "      const child = Reflect.get(value, key, value);",
    "      const childPath = [...path, key];",
    "      if (isObject(child) && (child.type === \"namespace\" || \"tools\" in child)) { flatten(child.tools, typeof child.name === \"string\" ? child.name : (prefix ? prefix + \"__\" + key : key), childPath); continue; }",
    "      if (isObject(child) && !descriptorLike(child)) { flatten(child, prefix ? prefix + \"__\" + key : key, childPath); continue; }",
    "      addEntry(child, key, prefix, childPath);",
    "    }",
    "  };",
    "  try { flatten(typeof ALL_TOOLS !== \"undefined\" ? ALL_TOOLS : undefined); } catch {}",
    "  try { flatten(source); } catch {}",
    "  const resolveNative = name => {",
    "    try { const direct = Reflect.get(source, name, source); if (typeof direct === \"function\") return { value: direct, owner: source }; } catch {}",
    "    for (const path of paths.get(name) || []) {",
    "      let owner = source;",
    "      try { for (const part of path.slice(0, -1)) owner = Reflect.get(owner, part, owner); const value = Reflect.get(owner, path.at(-1), owner); if (typeof value === \"function\") return { value, owner }; } catch {}",
    "    }",
    "    return undefined;",
    "  };",
    "  const wrappers = new Map();",
    "  const expose = name => {",
    "    if (wrappers.has(name)) return wrappers.get(name);",
    "    const resolved = resolveNative(name);",
    "    const value = resolved?.value;",
    "    let exposed = value;",
    "    if (typeof value === \"function\" && name === blockedExecName) {",
    "      exposed = () => { throw new Error(\"Nested raw exec is unavailable inside ChatGPT Web exec\"); };",
    "    } else if (typeof value === \"function\" && typeof name === \"string\" && waitNames.has(name)) {",
    "      exposed = args => {",
    "        if (!args || typeof args !== \"object\" || Array.isArray(args) || args.timeout_ms !== pollMs) {",
    "          throw new Error(\"ChatGPT Web wait_agent requires timeout_ms=\" + pollMs + \" so the shared MCP channel remains available to spawned Web agents\");",
    "        }",
    "        return Reflect.apply(value, resolved.owner, [args]);",
    "      };",
    "    } else if (typeof value === \"function\") {",
    "      exposed = (...args) => Reflect.apply(value, resolved.owner, args);",
    "    }",
    "    wrappers.set(name, exposed);",
    "    return exposed;",
    "  };",
    "  return new Proxy(Object.create(null), {",
    "    get: (_target, name) => expose(name),",
    "    has: (_target, name) => registryNames.has(name) || Boolean(resolveNative(name)),",
    "    ownKeys: () => [...registryNames],",
    "    getOwnPropertyDescriptor: (_target, name) =>",
    "      registryNames.has(name) || Reflect.has(source, name)",
    "        ? { configurable: true, enumerable: true, writable: false, value: expose(name) }",
    "        : undefined,",
    "    set: () => false,",
    "    defineProperty: () => false,",
    "    deleteProperty: () => false,",
    "    setPrototypeOf: () => false,",
    "    getPrototypeOf: () => null,",
    "    preventExtensions: () => false,",
    "  });",
    "})());",
  ].join("\n");
}

function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  const execCommandName = "exec_command";
  const shellCommandName = "shell_command";
  return execGatewayResultProgram([
    "const isObject = value => value !== null && typeof value === \"object\" && !Array.isArray(value);",
    "const descriptorLike = value => isObject(value) && (typeof value.type === \"string\" || typeof value.name === \"string\" || typeof value.description === \"string\" || \"parameters\" in value || \"input_schema\" in value || \"inputSchema\" in value || \"schema\" in value || \"format\" in value);",
    "const nativeNames = new Set();",
    "const paths = new Map();",
    "const addEntry = (entry, fallbackName, prefix = \"\", path = []) => {",
    "  const ownName = typeof entry === \"string\" ? entry : isObject(entry) && typeof entry.name === \"string\" ? entry.name : fallbackName;",
    "  const explicitNamespace = isObject(entry) && typeof entry.namespace === \"string\" ? entry.namespace : \"\";",
    "  const name = explicitNamespace ? explicitNamespace + \"__\" + ownName : prefix ? (ownName?.startsWith(prefix + \"__\") ? ownName : prefix + \"__\" + ownName) : ownName;",
    "  if (typeof name !== \"string\" || name.length === 0) return;",
    "  nativeNames.add(name);",
    "  const candidate = path.length > 0 ? path : [name];",
    "  const list = paths.get(name) || [];",
    "  if (!list.some(item => item.length === candidate.length && item.every((part, index) => part === candidate[index]))) list.push(candidate);",
    "  paths.set(name, list);",
    "};",
    "const flatten = (value, prefix = \"\", path = []) => {",
    "  if (Array.isArray(value)) { for (const entry of value) { if (isObject(entry) && (entry.type === \"namespace\" || \"tools\" in entry)) flatten(entry.tools, typeof entry.name === \"string\" ? entry.name : prefix, path); else addEntry(entry, undefined, prefix, path); } return; }",
    "  if (!isObject(value)) return;",
    "  if (value.type === \"namespace\" || (\"tools\" in value && !descriptorLike(value))) { flatten(value.tools, typeof value.name === \"string\" ? value.name : prefix, path); return; }",
    "  for (const key of Reflect.ownKeys(value)) { if (typeof key !== \"string\") continue; const child = Reflect.get(value, key, value); const childPath = [...path, key]; if (isObject(child) && (child.type === \"namespace\" || \"tools\" in child)) { flatten(child.tools, typeof child.name === \"string\" ? child.name : (prefix ? prefix + \"__\" + key : key), childPath); continue; } if (isObject(child) && !descriptorLike(child)) { flatten(child, prefix ? prefix + \"__\" + key : key, childPath); continue; } addEntry(child, key, prefix, childPath); }",
    "};",
    "try { flatten(typeof ALL_TOOLS !== \"undefined\" ? ALL_TOOLS : undefined); } catch {}",
    "try { flatten(tools); } catch {}",
    "const resolveNative = name => { try { const direct = Reflect.get(tools, name, tools); if (typeof direct === \"function\") return { value: direct, owner: tools }; } catch {} for (const path of paths.get(name) || []) { let owner = tools; try { for (const part of path.slice(0, -1)) owner = Reflect.get(owner, part, owner); const value = Reflect.get(owner, path.at(-1), owner); if (typeof value === \"function\") return { value, owner }; } catch {} } return undefined; };",
    `const nativeCommandCandidates = ${JSON.stringify([execCommandName, shellCommandName])}.filter(name => (nativeNames.size === 0 || nativeNames.has(name)) && resolveNative(name));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandName = nativeCommandCandidates[0];",
    "const nativeCommand = resolveNative(nativeCommandName);",
    "if (!nativeCommand) throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await Reflect.apply(nativeCommand.value, nativeCommand.owner, [nativeCommandInput]);",
  ]);
}

export async function runChatGptMcpServer(options: {
  brokerSocketPath: string;
  contract?: ChatGptMcpContract;
}): Promise<void> {
  const contract = options.contract ?? "native";
  const server = new McpServer(
    { name: contract === "safe" ? "codex-safe" : "codex-native", version: VERSION },
    contract === "safe" ? { instructions: ZERO_RISK_MCP_INSTRUCTIONS } : undefined,
  );

  const claimTurn = async (
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
  ): Promise<ClaimedTurn> => {
    console.error(`[chatgpt-web-mcp] ${toolName} scope=${requestScopeSummary(extra)}`);
    const activityId = `activity_${randomBytes(18).toString("base64url")}`;
    try {
      const claimed = await callTurnBroker<Omit<ClaimedTurn, "activityId">>(
        options.brokerSocketPath,
        { method: "claim", token: turnToken, activityId, contract },
        contract === "safe" ? null : 5_000,
        extra.signal,
      );
      return { ...claimed, activityId };
    } catch (error) {
      try {
        await settleTurnActivity(turnToken, activityId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Codex Native claim failed and its broker activity could not be retired",
        );
      }
      throw error;
    }
  };

  const settleTurnActivity = async (turnToken: string, activityId: string): Promise<void> => {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await callTurnBroker(options.brokerSocketPath, {
          method: "activity_complete",
          token: turnToken,
          activityId,
        }, 5_000);
        return;
      } catch (error) {
        firstError ??= error;
      }
    }
    throw new AggregateError(
      [firstError],
      "Codex Native broker activity cleanup failed after an idempotent retry",
    );
  };

  const withClaimedTurn = async <T>(
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
    action: (claimed: ClaimedTurn) => Promise<T> | T,
  ): Promise<T> => {
    const claimed = await claimTurn(toolName, turnToken, extra);
    try {
      return await action(claimed);
    } finally {
      // The broker's terminal fence treats even a fully local inventory lookup as live MCP work.
      // Settle the lease without the request AbortSignal: cancellation must not strand activity
      // and silently prevent every later completion candidate from committing.
      await settleTurnActivity(turnToken, claimed.activityId);
    }
  };

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk request",
        description: "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
        inputSchema: {
          request_id: turnTokenSchema,
        },
        outputSchema: {
          started: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ started: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_start",
          token: request_id,
        }, 5_000, extra.signal);
        return result(response);
      },
    );
  }

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    extra: McpRequestExtra,
  ) => {
    const timeoutMs = chatGptMcpInvocationTimeout(bound);
    try {
      const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
        method: "invoke",
        bindingId,
        wireName: wireName(tool),
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
        invocationKey: mcpInvocationKey(extra, bindingId, tool, payload),
      }, timeoutMs, extra.signal);
      return asMcpResult(response);
    } catch (error) {
      if (error instanceof TurnBrokerTimeoutError) {
        const toolName = wireName(tool);
        console.error(
          `[chatgpt-web-mcp] ${toolName} did not complete within ${timeoutMs}ms; preserving its turn binding for native reconnect`,
        );
        return result({
          code: "codex_tool_timeout",
          tool: toolName,
          timeout_ms: timeoutMs,
          retryable: true,
          binding_preserved: true,
          message: `Codex tool ${toolName} did not complete before the MCP transport deadline. The current turn binding remains active and the original call will be replayed to the next native Codex consumer. Retry this same tool request only if the response continues.`,
        }, true);
      }
      // Explicit cancellation and non-timeout broker failures have no safe consumer to resume.
      // Keep the existing fail-closed behavior for those cases.
      try {
        await callTurnBroker(options.brokerSocketPath, {
          method: "release",
          bindingId,
        });
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Codex Native invocation failed and its abandoned broker binding could not be retired",
        );
      }
      throw error;
    }
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    extra: McpRequestExtra,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(chatGptUnavailableToolMessage(nestedToolName, toolCapabilityReport(bound, contract)));
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload, bound.tools.map(wireName)),
    }, extra);
  };

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: afterSafeStart(contract, "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id."),
      inputSchema: {
        ...turnReferenceInput(contract),
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
        sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional()
          .describe("Native Codex sandbox request, only when the current command tool supports it. Codex decides whether to approve."),
        justification: z.string().optional()
          .describe("Approval question for a native require_escalated request; omit otherwise."),
        prefix_rule: z.array(z.string()).optional()
          .describe("Optional native approval prefix for require_escalated; Codex owns its approval and persistence."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_exec",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { cmd, workdir, yield_time_ms, max_output_tokens, tty, sandbox_permissions, justification, prefix_rule } = input;
        const bound = claimed.environment;
        const permissions = {
          ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}),
          ...(justification !== undefined ? { justification } : {}),
          ...(prefix_rule !== undefined ? { prefix_rule } : {}),
        };
        const execCommandArguments = {
          cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
          ...(tty !== undefined ? { tty } : {}),
          ...permissions,
        };
        const shellCommandArguments = {
          command: cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
          ...permissions,
        };
        const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
        if (tool) {
          // Never silently discard an approval request on a native registry that cannot express it.
          const properties = tool.parameters.properties;
          for (const key of Object.keys(permissions)) {
            if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
              throw new Error(`The current native ${tool.name} tool does not support ${key}`);
            }
          }
          const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
          return invoke(claimed.bindingId, bound, tool, { arguments: args }, extra);
        }
        const gateway = execGateway(bound);
        if (!gateway) {
          throw new Error(chatGptUnavailableToolMessage("exec_command", toolCapabilityReport(bound, contract)));
        }
        return invoke(claimed.bindingId, bound, gateway, {
          input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
        }, extra);
      },
    ),
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: afterSafeStart(contract, "Write characters to, or poll, a session_id returned by codex_exec."),
      inputSchema: {
        ...turnReferenceInput(contract),
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_write_stdin",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { session_id, chars, yield_time_ms, max_output_tokens } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "write_stdin");
        const payload = { arguments: {
          session_id,
          ...(chars !== undefined ? { chars } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        } };
        return tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra)
          : invokeNestedNative(claimed.bindingId, bound, "write_stdin", false, payload, extra);
      },
    ),
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: afterSafeStart(contract, "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task."),
      inputSchema: { ...turnReferenceInput(contract), patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_apply_patch",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { patch } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "apply_patch");
        if (!tool) return invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch }, extra);
        return tool.freeform
          ? invoke(claimed.bindingId, bound, tool, { input: patch }, extra)
          : invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } }, extra);
      },
    ),
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: afterSafeStart(contract, "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response."),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_view_image",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { path, detail } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "view_image");
        const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
        return tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra)
          : invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload, extra);
      },
    ),
  );

  server.registerTool(
    "codex_tool_capabilities",
    {
      title: "Inspect current Codex tool capabilities",
      description: afterSafeStart(contract,
        "Return the exact tool catalog hash, logical surfaces, direct/deferred provenance, and recovery action for this Codex turn. "
        + "Use this before reporting browser, computer, execution, MCP, or subagent tooling as unavailable. "
        + "A missing capability here means the outer Codex harness did not advertise it; the bridge will not fabricate a native handler."),
      inputSchema: turnReferenceInput(contract),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_tool_capabilities",
      turnReference(contract, input),
      extra,
      async claimed => result(toolCapabilityReport(claimed.environment, contract)),
    ),
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: contract === "safe"
        ? "List tools available to the connected Zero Risk request, including configured MCP and app tools."
        : "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        ...turnReferenceInput(contract),
        query: z.string().max(500).optional(),
        surface: z.enum(CHATGPT_TOOL_SURFACE_IDS).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_tool_inventory",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { query, surface, offset, limit, include_schema } = input;
        const bound = claimed.environment;
        const needle = query?.trim().toLowerCase();
        const visibleTools = safeVisibleTools(bound, contract);
        const directMatches = visibleTools.filter(tool => !needle || [
          wireName(tool),
          tool.name,
          tool.namespace ?? "",
          tool.description,
        ].join("\n").toLowerCase().includes(needle))
          .filter(tool => !surface || chatGptToolSurfaceForTool(tool) === surface);
        const directPage = directMatches.slice(offset, offset + limit).map(tool => ({
          wire_name: wireName(tool),
          name: tool.name,
          namespace: tool.namespace ?? null,
          description: browserToolDescription(tool),
          kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
          ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
        }));
        let nestedTotal = 0;
        let nestedPage: Array<Record<string, unknown>> = [];
        const gateway = execGateway(bound);
        if (gateway) {
          const excludedGatewayNames = bound.tools.map(wireName);
          // Treat direct and gateway tools as one ordered catalog. A page that starts inside the
          // direct portion must not append gateway entries and silently skip the remaining direct
          // entries on the next page.
          const gatewayPageRequested = offset >= directMatches.length;
          const nestedOffset = gatewayPageRequested ? offset - directMatches.length : 0;
          const nestedLimit = gatewayPageRequested ? limit : 0;
          const response = await invoke(claimed.bindingId, bound, gateway, {
            input: gatewayToolCatalogProgram({
              query,
              surface,
              offset: nestedOffset,
              limit: nestedLimit,
              // A gateway-discovered entry may supplement the outer registry, but it must never
              // duplicate or reopen an outer tool that this contract deliberately hid (including
              // our own MCP namespace in Zero Risk).
              excludedNames: excludedGatewayNames,
            }),
          }, extra);
          const catalog = gatewayToolCatalogPage(response, new Set(excludedGatewayNames));
          nestedTotal = catalog.total;
          nestedPage = catalog.tools.map(tool => ({
            wire_name: tool.name,
            name: tool.name,
            namespace: null,
            description: gatewayToolDescription(tool),
            kind: "gateway",
            ...(include_schema ? {
              parameters: gatewayToolParameters(tool),
            } : {}),
          }));
        }
        const page = [...directPage, ...nestedPage];
        const total = directMatches.length + nestedTotal;
        // A filtered registry miss does not mean deferred tools are unavailable. Expose the
        // actual native discovery entry separately; it is not a query match or an automatic call.
        const discoveryTools = needle && total === 0
          ? visibleTools.filter(tool => tool.toolSearch).map(tool => ({
            wire_name: wireName(tool),
            name: tool.name,
            namespace: tool.namespace ?? null,
            description: browserToolDescription(tool),
            kind: "tool_search",
            ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
          }))
          : [];
        return result({
          tools: page,
          total,
          next_offset: offset + page.length < total ? offset + page.length : null,
          ...(discoveryTools.length > 0 ? { discovery_tools: discoveryTools } : {}),
        });
      },
    ),
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: afterSafeStart(contract, [
        "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
        ...(contract === "native" ? [
          `A pending context-compaction request can also provide the reserved ${CODEX_COMPACTION_CONTROL_WIRE_NAME} operation, which is not listed by inventory.`,
          "Use only that request's issued control token and arguments {handoff_id, summary}. This operation submits the conversation summary to the pending Codex task; it does not execute commands, access files, or invoke other tools.",
        ] : []),
      ].join(" ")),
      inputSchema: {
        ...turnReferenceInput(contract),
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (toolInput, extra) => {
      const { wire_name, arguments: args, input } = toolInput;
      const requestId = turnReference(contract, toolInput);
      if (contract === "native" && wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME) {
        if (input !== undefined) {
          throw new Error("Compaction control handoff does not accept freeform input");
        }
        const handoffId = args?.handoff_id;
        const summary = args?.summary;
        if (typeof handoffId !== "string" || handoffId.length === 0) {
          throw new Error("Compaction control handoff requires handoff_id");
        }
        if (typeof summary !== "string") {
          throw new Error("Compaction control handoff requires summary");
        }
        await callTurnBroker(options.brokerSocketPath, {
          method: "submit_compaction_handoff",
          token: requestId,
          handoffId,
          summary,
        }, 5_000, extra.signal);
        return result({ submitted: true });
      }
      return withClaimedTurn("codex_tool_call", requestId, extra, async claimed => {
        const bound = claimed.environment;
        const tool = safeVisibleTools(bound, contract)
          .find(candidate => wireName(candidate) === wire_name);
        if (!tool) {
          const gateway = execGateway(bound);
          const hiddenOuterTool = bound.tools.some(candidate => wireName(candidate) === wire_name);
          if (!gateway || hiddenOuterTool || !gatewayToolNameIsValid(wire_name)) {
            throw new Error(chatGptUnavailableToolMessage(wire_name, toolCapabilityReport(bound, contract)));
          }
          if (input !== undefined && args && Object.keys(args).length > 0) {
            throw new Error(`Codex nested tool ${wire_name} accepts either arguments or freeform input, not both`);
          }
          if (isGatewayAgentWaitTool(wire_name) && input !== undefined) {
            throw new Error(`ChatGPT Web wait_agent requires structured arguments and timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`);
          }
          const invocationArguments = args ?? {};
          assertGatewayToolArguments(wire_name, invocationArguments);
          return invoke(claimed.bindingId, bound, gateway, {
            input: execGatewayProgram(wire_name, input !== undefined, {
              ...(input !== undefined ? { input } : { arguments: invocationArguments }),
            }, bound.tools.map(wireName)),
          }, extra);
        }
        if (tool.freeform) {
          if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
          if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
          return invoke(claimed.bindingId, bound, tool, {
            input: tool === execGateway(bound) ? transportBoundRawExecProgram(input, wireName(tool)) : input,
          }, extra);
        }
        if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
        const invocationArguments = args ?? {};
        assertBrowserToolArguments(tool, invocationArguments);
        return invoke(claimed.bindingId, bound, tool, { arguments: invocationArguments }, extra);
      });
    },
  );

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id, final_answer }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_complete",
          token: request_id,
          finalAnswer: final_answer,
        }, null, extra.signal);
        return result(response);
      },
    );
  }

  await server.connect(observeMcpToolCalls(new StdioServerTransport(), BRIDGE_TOOL_NAMES));
}
