import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, join } from "node:path";
import type { BrokerToolResult } from "./turn-broker";

interface LocalSession {
  owner: string;
  process: ChildProcessWithoutNullStreams;
  startedAt: number;
  output: string;
  truncated: boolean;
  done: boolean;
  exitCode: number | null;
  failure?: string;
  settled: Promise<void>;
}

const MAX_BUFFER_CHARS = 2_000_000;
const MAX_SESSIONS_PER_TURN = 8;

function boundedWait(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

function outputLimit(value: unknown): number {
  return Math.min(200_000, Math.max(1_000, boundedWait(value, 10_000, 50_000) * 4));
}

function toolResult(value: Record<string, unknown>): BrokerToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

async function waitForSettlement(settled: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Command recovery for trusted unrestricted turns when Codex omitted a native command handler.
 * It never handles restricted sandboxes, approvals, plugins, or arbitrary native tool names.
 * The broker owns processes and replay keys, so an MCP connector restart cannot repeat a command.
 */
export class ChatGptLocalExecution {
  private readonly sessions = new Map<number, LocalSession>();
  private nextId = 1;

  async exec(owner: string, cwd: string, args: Record<string, unknown>): Promise<BrokerToolResult> {
    const cmd = args.cmd;
    if (typeof cmd !== "string" || !cmd.trim() || cmd.length > 100_000) {
      throw new Error("Local command recovery requires a nonempty cmd");
    }
    if (args.tty === true) throw new Error("Local command recovery does not provide a PTY");
    if (args.sandbox_permissions === "require_escalated" || args.justification !== undefined || args.prefix_rule !== undefined) {
      throw new Error("Local command recovery cannot request a native approval");
    }
    if (args.sandbox_permissions !== undefined && args.sandbox_permissions !== "use_default") {
      throw new Error("Local command recovery received an unsupported sandbox request");
    }
    const workdir = args.workdir ?? cwd;
    if (typeof workdir !== "string" || !isAbsolute(workdir)) {
      throw new Error("Local command recovery requires an absolute workdir");
    }
    if ([...this.sessions.values()].filter(session => session.owner === owner && !session.done).length >= MAX_SESSIONS_PER_TURN) {
      throw new Error("Local command recovery has too many active sessions in this turn");
    }
    const shell = process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "/bin/bash";
    const shellArgs = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", cmd]
      : ["-lc", cmd];
    const child = spawn(shell, shellArgs, { cwd: workdir, stdio: "pipe", windowsHide: true });
    const id = this.nextId++;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const session: LocalSession = {
      owner, process: child, startedAt: Date.now(), output: "", truncated: false,
      done: false, exitCode: null, settled,
    };
    this.sessions.set(id, session);
    const append = (chunk: string) => {
      session.output += chunk;
      if (session.output.length > MAX_BUFFER_CHARS) {
        session.output = session.output.slice(-MAX_BUFFER_CHARS);
        session.truncated = true;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdin.on("error", () => {});
    child.on("error", error => {
      session.failure = error.message;
      session.done = true;
      settle();
    });
    child.on("close", code => {
      session.exitCode = code;
      session.done = true;
      settle();
    });
    await waitForSettlement(settled, boundedWait(args.yield_time_ms, 10_000, 30_000));
    return this.snapshot(id, session, outputLimit(args.max_output_tokens));
  }

  async write(owner: string, args: Record<string, unknown>): Promise<BrokerToolResult> {
    const id = args.session_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new Error("Local command recovery requires a valid session_id");
    }
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new Error("Local command session is unavailable in this turn");
    if (args.chars !== undefined) {
      if (typeof args.chars !== "string" || args.chars.length > 1_000_000) {
        throw new Error("Local command session received invalid chars");
      }
      if (args.chars === "\u0003") session.process.kill();
      else if (!session.done) session.process.stdin.write(args.chars);
    }
    if (!session.done) {
      await waitForSettlement(session.settled, boundedWait(args.yield_time_ms, 5_000, 30_000));
    }
    return this.snapshot(id, session, outputLimit(args.max_output_tokens));
  }

  retire(owner: string): void {
    for (const [id, session] of this.sessions) {
      if (session.owner !== owner) continue;
      if (!session.done) session.process.kill();
      this.sessions.delete(id);
    }
  }

  close(): void {
    for (const owner of new Set([...this.sessions.values()].map(session => session.owner))) this.retire(owner);
  }

  private snapshot(id: number, session: LocalSession, limit: number): BrokerToolResult {
    let output = session.output;
    session.output = "";
    if (session.truncated || output.length > limit) {
      output = `[Earlier output truncated]\n${output.slice(-limit)}`;
      session.truncated = false;
    }
    if (session.failure) output += `\n${session.failure}`;
    const response: Record<string, unknown> = {
      output,
      wall_time_seconds: (Date.now() - session.startedAt) / 1_000,
      ...(session.done ? { exit_code: session.exitCode } : { session_id: id }),
    };
    if (session.done) this.sessions.delete(id);
    return toolResult(response);
  }
}
