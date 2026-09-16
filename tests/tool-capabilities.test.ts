import { expect, test } from "bun:test";
import {
  buildChatGptToolCapabilityReport,
  chatGptToolCatalogHash,
  chatGptToolSurface,
  chatGptToolSurfaceForWireName,
  chatGptUnavailableToolMessage,
} from "../src/adapters/chatgpt-web/tool-capabilities";

test("classifies native and namespaced tools into stable logical surfaces", () => {
  expect(chatGptToolSurface({ name: "exec_command", description: "Run a local command" })).toBe("execution");
  expect(chatGptToolSurface({ name: "get_app_state", description: "Read the current desktop state" })).toBe("computer");
  expect(chatGptToolSurface({ name: "run", namespace: "mcp__open_computer_use", description: "Control the desktop" })).toBe("computer");
  expect(chatGptToolSurface({ name: "search", namespace: "mcp__context7", description: "Search documentation" })).toBe("mcp");
  expect(chatGptToolSurfaceForWireName("mcp__context7__search")).toBe("mcp");
  expect(chatGptToolSurface({ name: "tool_search", description: "Load a deferred tool" })).toBe("discovery");
});

test("capability reports preserve direct tools while exposing gateway recovery", () => {
  const report = buildChatGptToolCapabilityReport({
    outerTools: [
      { name: "exec", description: "Run native code", parameters: {}, freeform: true, source: "additional_tools" },
      { name: "exec_command", description: "Run a command", parameters: { type: "object" } },
      { name: "tool_search", description: "Find deferred tools", parameters: { type: "object" }, toolSearch: true, source: "tool_search_output" },
    ],
    visibleTools: [
      { name: "exec", description: "Run native code", parameters: {}, freeform: true, source: "additional_tools" },
      { name: "exec_command", description: "Run a command", parameters: { type: "object" } },
      { name: "tool_search", description: "Find deferred tools", parameters: { type: "object" }, toolSearch: true, source: "tool_search_output" },
    ],
    gateway: { name: "exec", description: "Run native code", parameters: {}, freeform: true },
    contract: "native",
  });

  expect(report.protocol_version).toBe(2);
  expect(report.gateway).toEqual({
    available: true,
    wire_name: "exec",
    can_discover_deferred: true,
  });
  expect(report.discovery).toEqual({ tool_search: true, inventory: true, exact_call: true });
  expect(report.source_counts).toEqual({ declared: 1, additional_tools: 1, tool_search_output: 1 });
  expect(report.surfaces.execution).toMatchObject({ availability: "direct", direct_count: 2 });
  expect(report.surfaces.computer).toMatchObject({ availability: "gateway", deferred_possible: true });
  expect(report.recovery.status).toBe("ready");
  expect(report.catalog_epoch).toStartWith("codex-web-gpt-tooling-v2:");
});

test("missing native capabilities produce an actionable outer-catalog diagnosis", () => {
  const report = buildChatGptToolCapabilityReport({
    outerTools: [],
    visibleTools: [],
    contract: "native",
  });
  const message = chatGptUnavailableToolMessage("get_app_state", report);

  expect(report.recovery.status).toBe("unavailable");
  expect(report.gateway.available).toBe(false);
  expect(message).toContain("not available in this turn");
  expect(message).toContain("surface=computer");
  expect(message).toContain("no native exec gateway");
  expect(message).toContain("codex_tool_capabilities");
});

test("catalog hashes are order independent but change when the advertised contract changes", () => {
  const command = { name: "exec_command", description: "Run", parameters: { type: "object" } };
  const image = { name: "view_image", description: "View", parameters: { type: "object" } };
  expect(chatGptToolCatalogHash([command, image])).toBe(chatGptToolCatalogHash([image, command]));
  expect(chatGptToolCatalogHash([command])).not.toBe(chatGptToolCatalogHash([command, image]));
});
