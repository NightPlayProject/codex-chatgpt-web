import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker, callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { defaultBrokerEndpoint } from "../src/config";

function endpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

function recoveryEnvironment(cwd: string): ChatGptTurnEnvironment {
  return {
    cwd, roots: [cwd], writableRoots: [cwd],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
    localExecutionRecovery: true,
  };
}

test("unrestricted missing-catalog turn executes and replays a command without a native function call", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cgw-local-recovery-"));
  const broker = TurnBroker.forSocket(endpoint(`cgw-local-${process.pid}-${Date.now()}`));
  try {
    const token = await broker.register(recoveryEnvironment(cwd));
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token });
    const command = process.platform === "win32"
      ? "Add-Content -Encoding utf8 -Path marker.txt -Value recovery"
      : "echo recovery >> marker.txt";
    const request = {
      method: "invoke_local_exec" as const,
      bindingId,
      arguments: { cmd: command, workdir: cwd, yield_time_ms: 10_000 },
      invocationKey: "same-command-replay",
    };
    const first = await callTurnBroker<BrokerToolResult>(broker.socketPath, request);
    const second = await callTurnBroker<BrokerToolResult>(broker.socketPath, request);
    expect(first.structuredContent).toMatchObject({ exit_code: 0 });
    expect(second).toEqual(first);
    expect(readFileSync(join(cwd, "marker.txt"), "utf8").trim().split(/\r?\n/)).toEqual(["recovery"]);
    await expect(broker.nextToolBatch(token, AbortSignal.timeout(30))).rejects.toBeDefined();
  } finally {
    await broker.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("local recovery supports a command session and rejects native approval escalation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cgw-local-session-"));
  const broker = TurnBroker.forSocket(endpoint(`cgw-session-${process.pid}-${Date.now()}`));
  try {
    const token = await broker.register(recoveryEnvironment(cwd));
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token });
    const command = process.platform === "win32"
      ? "Start-Sleep -Seconds 1; Write-Output session-ok"
      : "sleep 1; echo session-ok";
    const started = await callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke_local_exec", bindingId, arguments: { cmd: command, yield_time_ms: 0 },
      invocationKey: "start-session",
    });
    const id = (started.structuredContent as { session_id: number }).session_id;
    expect(id).toBeGreaterThan(0);
    const completed = await callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke_local_stdin", bindingId, arguments: { session_id: id, yield_time_ms: 5_000 },
      invocationKey: "poll-session",
    });
    expect(completed.structuredContent).toMatchObject({ exit_code: 0 });
    expect((completed.structuredContent as { output: string }).output).toContain("session-ok");
    await expect(callTurnBroker(broker.socketPath, {
      method: "invoke_local_exec", bindingId,
      arguments: { cmd: "echo should-not-run", sandbox_permissions: "require_escalated" },
      invocationKey: "approval-rejected",
    })).rejects.toThrow("cannot request a native approval");
  } finally {
    await broker.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("restricted sandbox cannot opt into local command recovery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cgw-local-restricted-"));
  const broker = TurnBroker.forSocket(endpoint(`cgw-restricted-${process.pid}-${Date.now()}`));
  try {
    const environment: ChatGptTurnEnvironment = {
      cwd, roots: [cwd], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
    };
    const token = await broker.register(environment);
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token });
    await expect(callTurnBroker(broker.socketPath, {
      method: "invoke_local_exec", bindingId, arguments: { cmd: "echo forbidden" },
      invocationKey: "restricted",
    })).rejects.toThrow("unavailable for this Codex turn");
  } finally {
    await broker.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the ChatGPT MCP connector advertises and runs local recovery without emitting a phantom native call", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cgw-local-mcp-"));
  const broker = TurnBroker.forSocket(endpoint(`cgw-mcp-${process.pid}-${Date.now()}`));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", broker.socketPath],
    cwd: process.cwd(), stderr: "pipe",
  });
  const client = new Client({ name: "local-recovery-test", version: "1" });
  try {
    const token = await broker.register(recoveryEnvironment(cwd));
    await client.connect(transport);
    const capabilities = await client.callTool({ name: "codex_tool_capabilities", arguments: { turn_token: token } });
    expect(capabilities.structuredContent).toMatchObject({
      outer_tool_count: 0,
      local_execution_recovery: { available: true, execution: "codex_exec" },
      surfaces: {
        execution: { availability: "local", direct_count: 0 },
        filesystem: { availability: "local", direct_count: 0 },
      },
      recovery: { status: "partial" },
    });
    const result = await client.callTool({
      name: "codex_exec", arguments: { turn_token: token, cmd: "echo local-mcp-ok", workdir: cwd },
    });
    expect(result.structuredContent).toMatchObject({ exit_code: 0 });
    expect((result.structuredContent as { output: string }).output).toContain("local-mcp-ok");
    await expect(broker.nextToolBatch(token, AbortSignal.timeout(30))).rejects.toBeDefined();
  } finally {
    await client.close().catch(() => {});
    await broker.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
