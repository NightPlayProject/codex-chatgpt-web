import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";

const freeformFormat = {
  type: "grammar",
  syntax: "lark",
  definition: 'start: "tool"',
};

function responsesLiteTools() {
  return [{
    type: "namespace",
    name: "functions",
    description: "",
    tools: [
      { type: "custom", name: "exec", description: "Run native Codex code", format: freeformFormat },
      {
        type: "function",
        name: "wait",
        description: "Wait for native Codex code",
        strict: false,
        parameters: { type: "object", properties: {} },
      },
    ],
  }, {
    type: "namespace",
    name: "mcp__python",
    description: "Python tools",
    tools: [{
      type: "custom",
      name: "run_script",
      description: "Run a Python script",
      format: freeformFormat,
    }],
  }];
}

function objectMappedComputerUseTools() {
  return {
    mcp__open_computer_use: {
      type: "namespace",
      description: "Native Windows Computer Use tools",
      tools: {
        get_app_state: {
          type: "function",
          description: "Read the current Windows app state",
          parameters: { type: "object", properties: {} },
        },
        click: {
          type: "function",
          description: "Click a visible Windows target",
          parameters: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
          },
        },
      },
    },
  };
}

function directNamespaceMapComputerUseTools() {
  return {
    "Microsoft.windows.Computer": {
      get_app_state: {
        description: "Read the current Windows app state",
        input_schema: { type: "object", properties: {} },
      },
      click: {
        type: "function",
        description: "Click a visible Windows target",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
        },
      },
    },
  };
}

test("Responses Lite preserves client tools from every namespace", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/luna",
    input: [{ type: "additional_tools", role: "developer", tools: responsesLiteTools() }],
  });

  expect(parsed.context.tools).toContainEqual(expect.objectContaining({
    name: "exec",
    freeform: true,
    source: "additional_tools",
  }));
  const waitTool = parsed.context.tools?.find(tool => tool.name === "wait");
  expect(waitTool).toEqual(expect.objectContaining({ name: "wait" }));
  expect(waitTool).not.toHaveProperty("namespace");
  expect(parsed.context.tools).toContainEqual(expect.objectContaining({
    name: "run_script",
    namespace: "mcp__python",
    freeform: true,
    source: "additional_tools",
  }));
});

test("Responses Lite keeps unnamed tool_search declarations", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    tools: [{ type: "tool_search" }],
    input: [{ type: "message", role: "user", content: "Find the desktop tools" }],
  });

  expect(parsed.context.tools).toContainEqual(expect.objectContaining({
    name: "tool_search",
    toolSearch: true,
    source: "declared",
  }));
});

test("Responses Lite preserves namespaced allowed tool choices", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    tools: [{
      type: "function",
      name: "click",
      namespace: "mcp__open_computer_use",
      parameters: { type: "object", properties: {} },
    }],
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [{
        type: "function",
        name: "click",
        namespace: "mcp__open_computer_use",
      }],
    },
    input: [{ type: "message", role: "user", content: "Click" }],
  });

  expect(parsed.options.toolChoice).toEqual({
    allowedTools: ["mcp__open_computer_use__click"],
    mode: "required",
  });
});

test("Responses Lite keeps object-mapped Computer Use tools addressable by exact wire name", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    input: [{ type: "additional_tools", role: "developer", tools: objectMappedComputerUseTools() }],
  });

  expect(parsed.context.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "get_app_state", namespace: "mcp__open_computer_use", source: "additional_tools" }),
    expect.objectContaining({ name: "click", namespace: "mcp__open_computer_use", source: "additional_tools" }),
  ]));
});

test("Responses Lite preserves direct namespace maps used by the native Computer registry", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    tools: directNamespaceMapComputerUseTools(),
    input: [{ type: "message", role: "user", content: "Read the current app state" }],
  });

  expect(parsed.context.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: "get_app_state",
      namespace: "Microsoft.windows.Computer",
      parameters: { type: "object", properties: {} },
    }),
    expect.objectContaining({
      name: "click",
      namespace: "Microsoft.windows.Computer",
      parameters: expect.objectContaining({ required: ["x", "y"] }),
    }),
  ]));
});

test("Responses Lite merges top-level deferred tool registries without losing nested namespaces", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    additional_tools: directNamespaceMapComputerUseTools(),
    tool_search_output: {
      "mcp__desktop": {
        screenshot: {
          type: "function",
          description: "Capture the desktop",
          parameters: { type: "object", properties: {} },
        },
      },
    },
    input: [{ type: "message", role: "user", content: "Inspect the desktop" }],
  });

  expect(parsed.context.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "get_app_state", namespace: "Microsoft.windows.Computer", source: "additional_tools" }),
    expect.objectContaining({ name: "screenshot", namespace: "mcp__desktop", source: "tool_search_output" }),
  ]));
});

test("Responses Lite flattens object-mapped tool-search output and reports callable wire names", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    input: [
      { type: "tool_search_call", id: "tool_search_call_1", call_id: "tool_search_call_1", arguments: "{}" },
      {
        type: "tool_search_output",
        call_id: "tool_search_call_1",
        status: "completed",
        tools: objectMappedComputerUseTools(),
      },
    ],
  });

  expect(parsed.context.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "get_app_state", namespace: "mcp__open_computer_use", source: "tool_search_output" }),
    expect.objectContaining({ name: "click", namespace: "mcp__open_computer_use", source: "tool_search_output" }),
  ]));
  const result = parsed.context.messages.find(message => message.role === "toolResult");
  expect(result?.role === "toolResult" ? result.content : "").toContain(
    "mcp__open_computer_use__get_app_state",
  );
  expect(result?.role === "toolResult" ? result.content : "").toContain(
    "mcp__open_computer_use__click",
  );
});

test("Responses Lite relays a static Computer Use call through its namespace", async () => {
  const config = defaultConfig("full");
  config.solAvailable = false;
  config.proAvailable = false;
  const turnId = "turn_responses_lite_computer_use_regression";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      metadata: { turn_id: turnId, thread_id: "thread_responses_lite_computer_use_regression" },
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: objectMappedComputerUseTools(),
      }, {
        type: "message",
        id: "msg_responses_lite_computer_use_regression",
        role: "user",
        content: [{ type: "input_text", text: "Read the current app state" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  }), config, () => ({
    name: "responses-lite-computer-use-regression",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.tools).toContainEqual(expect.objectContaining({
        name: "get_app_state",
        namespace: "mcp__open_computer_use",
      }));
      emit({ type: "tool_call_start", id: "call_get_app_state", name: "mcp__open_computer_use__get_app_state" });
      emit({ type: "tool_call_delta", arguments: "{}" });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: false });
    },
  }), { rememberState: false });

  expect(response.status).toBe(200);
  const body = await response.json() as { output: Array<Record<string, unknown>> };
  expect(body.output.filter(item => item.type === "function_call")).toEqual([expect.objectContaining({
    call_id: "call_get_app_state",
    name: "get_app_state",
    namespace: "mcp__open_computer_use",
    arguments: "{}",
  })]);
});

test("Responses Lite relays a direct Microsoft.windows.Computer registry call without renaming it", async () => {
  const config = defaultConfig("full");
  config.solAvailable = false;
  config.proAvailable = false;
  const turnId = "turn_responses_lite_windows_computer";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      metadata: { turn_id: turnId, thread_id: "thread_responses_lite_windows_computer" },
      tools: directNamespaceMapComputerUseTools(),
      input: [{
        type: "message",
        id: "msg_responses_lite_windows_computer",
        role: "user",
        content: [{ type: "input_text", text: "Read the current app state" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  }), config, () => ({
    name: "responses-lite-windows-computer",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.tools).toContainEqual(expect.objectContaining({
        name: "get_app_state",
        namespace: "Microsoft.windows.Computer",
      }));
      emit({ type: "tool_call_start", id: "call_windows_get_app_state", name: "Microsoft.windows.Computer__get_app_state" });
      emit({ type: "tool_call_delta", arguments: "{}" });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: false });
    },
  }), { rememberState: false });

  expect(response.status).toBe(200);
  const body = await response.json() as { output: Array<Record<string, unknown>> };
  expect(body.output.filter(item => item.type === "function_call")).toEqual([expect.objectContaining({
    call_id: "call_windows_get_app_state",
    name: "get_app_state",
    namespace: "Microsoft.windows.Computer",
    arguments: "{}",
  })]);
});

test("Responses Lite native exec survives a complete server request as one custom call", async () => {
  const config = defaultConfig("full");
  config.solAvailable = false;
  config.proAvailable = false;
  const turnId = "turn_responses_lite_exec_regression";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      metadata: { turn_id: turnId, thread_id: "thread_responses_lite_exec_regression" },
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: responsesLiteTools().slice(0, 1),
      }, {
        type: "message",
        id: "msg_responses_lite_exec_regression",
        role: "user",
        content: [{ type: "input_text", text: "Use the native exec tool" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  }), config, () => ({
    name: "responses-lite-exec-regression",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "exec", freeform: true }));
      emit({ type: "tool_call_start", id: "call_exec", name: "exec" });
      emit({ type: "tool_call_delta", arguments: JSON.stringify({ input: "text('ok')" }) });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: false });
    },
  }), { rememberState: false });

  expect(response.status).toBe(200);
  const body = await response.json() as { output: Array<Record<string, unknown>> };
  const calls = body.output.filter(item => item.type === "custom_tool_call");
  expect(calls).toEqual([expect.objectContaining({
    call_id: "call_exec",
    name: "exec",
    input: "text('ok')",
  })]);
});
