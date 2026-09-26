import { createHash } from "node:crypto";
import { namespacedToolName, type CodexTool } from "../../types";

/**
 * These are logical discovery surfaces, not additional permission boundaries. The outer Codex
 * harness remains the authority for whether a tool can run. Keeping the grouping here gives the
 * ChatGPT connector a stable way to ask for the right part of a large native catalog.
 */
export const CHATGPT_TOOL_SURFACE_IDS = [
  "execution",
  "filesystem",
  "browser",
  "computer",
  "mcp",
  "agents",
  "discovery",
  "other",
] as const;

export type ChatGptToolSurfaceId = typeof CHATGPT_TOOL_SURFACE_IDS[number];
export type ChatGptToolAvailability = "direct" | "gateway" | "local" | "unavailable";
export type ChatGptToolSource = "declared" | "additional_tools" | "tool_search_output";

export interface ChatGptToolSurfaceReport {
  availability: ChatGptToolAvailability;
  direct_count: number;
  direct_tools: string[];
  deferred_possible: boolean;
}

export interface ChatGptToolCapabilityReport {
  protocol_version: 2;
  contract: "native" | "safe";
  outer_tool_count: number;
  direct_tool_count: number;
  source_counts: Record<ChatGptToolSource, number>;
  catalog_hash: string;
  outer_catalog_hash: string;
  catalog_epoch: string;
  gateway: {
    available: boolean;
    wire_name: string | null;
    can_discover_deferred: boolean;
  };
  local_execution_recovery?: {
    available: true;
    execution: "codex_exec";
    command_sessions: "codex_write_stdin";
    filesystem: "Use filesystem commands through codex_exec";
    sandbox: "dangerFullAccess";
  };
  discovery: {
    tool_search: boolean;
    inventory: true;
    exact_call: true;
  };
  surfaces: Record<ChatGptToolSurfaceId, ChatGptToolSurfaceReport>;
  unavailable: Array<{
    surface: ChatGptToolSurfaceId;
    reason: string;
    next_action: string;
  }>;
  connector: {
    contract_version: "codex-web-gpt-tooling-v2";
    refresh_required_when: "connector_contract_changes";
    refresh_instruction: string;
  };
  recovery: {
    status: "ready" | "partial" | "unavailable";
    next_action: string;
  };
}

interface ToolSurfaceInput {
  name: string;
  namespace?: string;
  description?: string;
}

const MAX_SURFACE_TOOL_NAMES = 64;
const CONNECTOR_REFRESH_INSTRUCTION =
  "If codex_tool_capabilities is missing from the connector, refresh/reload the Codex Web GPT connector in ChatGPT, then start a new turn.";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function catalogEntry(tool: CodexTool): Record<string, unknown> {
  return {
    wire_name: namespacedToolName(tool.namespace, tool.name),
    name: tool.name,
    namespace: tool.namespace ?? null,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.freeform === true ? { freeform: true } : {}),
    ...(tool.toolSearch === true ? { tool_search: true } : {}),
    source: tool.source ?? "declared",
  };
}

export function chatGptToolCatalogHash(tools: readonly CodexTool[]): string {
  const entries = tools
    .map(catalogEntry)
    .sort((left, right) => String(left.wire_name).localeCompare(String(right.wire_name)));
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(entries)))
    .digest("hex");
}

export function chatGptToolSurface(input: ToolSurfaceInput): ChatGptToolSurfaceId {
  const name = `${input.namespace ?? ""}\n${input.name}\n${input.description ?? ""}`.toLowerCase();

  // Computer-use MCPs often carry a namespace such as open_computer_use, while native clients
  // expose names such as get_app_state/click directly. Check this before the generic MCP bucket.
  if (/(computer[_-]?use|desktop|screen|screenshot|get[_-]?app[_-]?state|mouse|keyboard|click|double[_-]?click|scroll|drag|keypress|type[_-]?text|open[_-]?app|close[_-]?app|window)/.test(name)) {
    return "computer";
  }
  if (/(browser|web[_-]?run|search[_-]?query|open[_-]?url|navigate|page|tab|website|fetch[_-]?url)/.test(name)) {
    return "browser";
  }
  if (/(agent|subagent|multi[_-]?agent|collaboration|spawn[_-]?agent|send[_-]?message|wait[_-]?agent)/.test(name)) {
    return "agents";
  }
  if (/(^|[\n_:/-])(exec|exec[_-]?command|shell[_-]?command|terminal|process|kill[_-]?process|write[_-]?stdin|run[_-]?command)([\n_:/-]|$)/.test(name)) {
    return "execution";
  }
  if (/(apply[_-]?patch|read[_-]?file|write[_-]?file|file|filesystem|directory|path|view[_-]?image|image)/.test(name)) {
    return "filesystem";
  }
  if (/(tool[_-]?search|tool[_-]?inventory|discover)/.test(name)) {
    return "discovery";
  }
  if (input.namespace || /(^mcp(?:__|[_:/-])|\bmcp\b|connector|plugin|app)/.test(name)) return "mcp";
  return "other";
}

export function chatGptToolSurfaceForTool(tool: CodexTool): ChatGptToolSurfaceId {
  return chatGptToolSurface({ name: tool.name, namespace: tool.namespace, description: tool.description });
}

export function chatGptToolSurfaceForWireName(wireName: string): ChatGptToolSurfaceId {
  const separator = wireName.lastIndexOf("__");
  return separator > 0 && separator < wireName.length - 2
    ? chatGptToolSurface({ namespace: wireName.slice(0, separator), name: wireName.slice(separator + 2) })
    : chatGptToolSurface({ name: wireName });
}

function emptySurfaceReport(): ChatGptToolSurfaceReport {
  return {
    availability: "unavailable",
    direct_count: 0,
    direct_tools: [],
    deferred_possible: false,
  };
}

function surfaceReports(
  tools: readonly CodexTool[],
  gatewayAvailable: boolean,
): Record<ChatGptToolSurfaceId, ChatGptToolSurfaceReport> {
  const reports = Object.fromEntries(
    CHATGPT_TOOL_SURFACE_IDS.map(surface => [surface, emptySurfaceReport()]),
  ) as Record<ChatGptToolSurfaceId, ChatGptToolSurfaceReport>;
  for (const tool of tools) {
    const surface = chatGptToolSurfaceForTool(tool);
    const report = reports[surface];
    report.direct_count += 1;
    if (report.direct_tools.length < MAX_SURFACE_TOOL_NAMES) {
      report.direct_tools.push(namespacedToolName(tool.namespace, tool.name));
    }
    report.availability = "direct";
  }
  if (gatewayAvailable) {
    for (const surface of CHATGPT_TOOL_SURFACE_IDS) {
      const report = reports[surface];
      report.deferred_possible = true;
      if (report.availability === "unavailable") report.availability = "gateway";
    }
  }
  return reports;
}

export function buildChatGptToolCapabilityReport(options: {
  outerTools: readonly CodexTool[];
  visibleTools: readonly CodexTool[];
  gateway?: CodexTool;
  contract: "native" | "safe";
  localExecutionRecovery?: boolean;
}): ChatGptToolCapabilityReport {
  const gateway = options.gateway;
  const gatewayAvailable = Boolean(gateway?.freeform === true);
  const toolSearch = options.visibleTools.some(tool => tool.toolSearch === true || tool.name === "tool_search");
  const surfaces = surfaceReports(options.visibleTools, gatewayAvailable);
  const localRecovery = options.contract === "native" && options.localExecutionRecovery === true;
  if (localRecovery) {
    if (surfaces.execution.availability !== "direct") surfaces.execution.availability = "local";
    if (surfaces.filesystem.availability !== "direct") surfaces.filesystem.availability = "local";
  }
  const unavailable = CHATGPT_TOOL_SURFACE_IDS
    .filter(surface => surfaces[surface].availability === "unavailable")
    .map(surface => ({
      surface,
      reason: "The outer Codex turn did not advertise a direct tool or native exec gateway for this surface.",
      next_action: "Reconnect the turn or use another enabled Codex subscription/model that advertises the required tools.",
    }));
  const catalogHash = chatGptToolCatalogHash(options.visibleTools);
  const outerCatalogHash = chatGptToolCatalogHash(options.outerTools);
  const sourceCounts: Record<ChatGptToolSource, number> = {
    declared: 0,
    additional_tools: 0,
    tool_search_output: 0,
  };
  for (const tool of options.visibleTools) sourceCounts[tool.source ?? "declared"] += 1;
  const directReady = options.visibleTools.length > 0;
  const status = directReady || gatewayAvailable || localRecovery
    ? unavailable.length === 0 ? "ready" : "partial"
    : "unavailable";
  return {
    protocol_version: 2,
    contract: options.contract,
    outer_tool_count: options.outerTools.length,
    direct_tool_count: options.visibleTools.length,
    source_counts: sourceCounts,
    catalog_hash: catalogHash,
    outer_catalog_hash: outerCatalogHash,
    catalog_epoch: `codex-web-gpt-tooling-v2:${catalogHash}`,
    gateway: {
      available: gatewayAvailable,
      wire_name: gatewayAvailable ? namespacedToolName(gateway!.namespace, gateway!.name) : null,
      can_discover_deferred: gatewayAvailable,
    },
    ...(localRecovery ? { local_execution_recovery: {
      available: true as const,
      execution: "codex_exec" as const,
      command_sessions: "codex_write_stdin" as const,
      filesystem: "Use filesystem commands through codex_exec" as const,
      sandbox: "dangerFullAccess" as const,
    } } : {}),
    discovery: {
      tool_search: toolSearch,
      inventory: true,
      exact_call: true,
    },
    surfaces,
    unavailable,
    connector: {
      contract_version: "codex-web-gpt-tooling-v2",
      refresh_required_when: "connector_contract_changes",
      refresh_instruction: CONNECTOR_REFRESH_INSTRUCTION,
    },
    recovery: {
      status,
      next_action: localRecovery
        ? "Use codex_exec for local commands and filesystem work; use codex_write_stdin to poll a returned session_id."
        : gatewayAvailable
        ? "Use codex_tool_inventory for the focused surface, then call the exact returned wire_name with codex_tool_call."
        : directReady
          ? "Use the exact direct tool name and schema from this catalog."
          : "Reconnect the Codex turn; no callable native tool surface was advertised.",
    },
  };
}

export function chatGptUnavailableToolMessage(
  wireName: string,
  report: ChatGptToolCapabilityReport,
): string {
  const surface = chatGptToolSurfaceForWireName(wireName);
  const details = report.gateway.available
    ? "The turn has a native exec gateway; query codex_tool_inventory for deferred tools before retrying."
    : "The turn has no native exec gateway, so the bridge cannot fabricate a missing native handler.";
  return `Codex tool is not available in this turn: ${wireName}. `
    + `The outer Codex catalog reports surface=${surface}, catalog_epoch=${report.catalog_epoch}. ${details} `
    + "Call codex_tool_capabilities to inspect the exact advertised surfaces before reporting the capability unavailable.";
}

export function chatGptToolingHealth(report: ChatGptToolCapabilityReport): {
  protocol_version: 2;
  catalog_hash: string;
  catalog_epoch: string;
  outer_catalog_hash: string;
  outer_tool_count: number;
  direct_tool_count: number;
  source_counts: Record<ChatGptToolSource, number>;
  gateway_available: boolean;
  local_execution_recovery_available: boolean;
  tool_search_available: boolean;
  surfaces: Record<ChatGptToolSurfaceId, { availability: ChatGptToolAvailability; direct_count: number; deferred_possible: boolean }>;
} {
  return {
    protocol_version: 2,
    catalog_hash: report.catalog_hash,
    catalog_epoch: report.catalog_epoch,
    outer_catalog_hash: report.outer_catalog_hash,
    outer_tool_count: report.outer_tool_count,
    direct_tool_count: report.direct_tool_count,
    source_counts: report.source_counts,
    gateway_available: report.gateway.available,
    local_execution_recovery_available: report.local_execution_recovery?.available === true,
    tool_search_available: report.discovery.tool_search,
    surfaces: Object.fromEntries(
      CHATGPT_TOOL_SURFACE_IDS.map(surface => [surface, {
        availability: report.surfaces[surface].availability,
        direct_count: report.surfaces[surface].direct_count,
        deferred_possible: report.surfaces[surface].deferred_possible,
      }]),
    ) as Record<ChatGptToolSurfaceId, { availability: ChatGptToolAvailability; direct_count: number; deferred_possible: boolean }>,
  };
}
