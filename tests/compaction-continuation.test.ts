import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptCompactionContinuationStore,
} from "../src/adapters/chatgpt-web/compaction-continuation";
import { extractChatGptTurnIdentity, type ChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { encodeCompactionSummary } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkpointFixture(options: {
  threadId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceText?: string;
  summary?: string;
  modelId?: string;
  reasoning?: string;
  compaction?: boolean;
} = {}): { parsed: CodexParsedRequest; source: ChatGptTurnUserRevision; summary: string } {
  const threadId = options.threadId ?? "thread_persisted_compaction";
  const turnId = options.turnId ?? "turn_after_compaction";
  const sourceTurnId = options.sourceTurnId ?? "turn_before_compaction";
  const sourceText = options.sourceText ?? "Continue the long-running project without losing context";
  const summary = options.summary ?? "Durable checkpoint for the long-running project";
  const sourceContent = [{ type: "input_text", text: sourceText }];
  const source = { turnId: sourceTurnId, content: sourceContent };
  const parsed: CodexParsedRequest = {
    modelId: options.modelId ?? "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: sourceText, timestamp: 1 }] },
    options: { reasoning: options.reasoning ?? "high" },
    ...(options.compaction ? { _compactionRequest: true } : {}),
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [
        {
          type: "message",
          role: "user",
          id: "msg_source",
          content: sourceContent,
          internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
        },
        ...(!options.compaction ? [{
          type: "compaction",
          encrypted_content: encodeCompactionSummary(summary),
        }] : []),
      ],
    },
  };
  return { parsed, source, summary };
}

test("completed compaction authority survives a fresh store without persisting prompt or summary plaintext", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-compaction-"));
  temporaryRoots.push(root);
  const path = join(root, "compaction-continuations.json");
  const compact = checkpointFixture({ compaction: true });
  const identity = extractChatGptTurnIdentity(compact.parsed);

  new ChatGptCompactionContinuationStore(path).remember(compact.parsed, identity, [compact.source], compact.summary);

  const persisted = readFileSync(path, "utf8");
  expect(persisted).not.toContain("Continue the long-running project");
  expect(persisted).not.toContain(compact.summary);

  const continuation = checkpointFixture();
  expect(new ChatGptCompactionContinuationStore(path).accepts(
    continuation.parsed,
    extractChatGptTurnIdentity(continuation.parsed),
    continuation.source,
  )).toBeTrue();
});

test("reloaded compaction authority remains bound to exact turn, model, effort, source and summary", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-compaction-"));
  temporaryRoots.push(root);
  const path = join(root, "compaction-continuations.json");
  const compact = checkpointFixture({ compaction: true });
  new ChatGptCompactionContinuationStore(path).remember(
    compact.parsed,
    extractChatGptTurnIdentity(compact.parsed),
    [compact.source],
    compact.summary,
  );

  for (const changed of [
    checkpointFixture({ threadId: "another_thread" }),
    checkpointFixture({ turnId: "another_turn" }),
    checkpointFixture({ modelId: "gpt-5.6-sol-pro" }),
    checkpointFixture({ reasoning: "medium" }),
    checkpointFixture({ sourceText: "Rewritten task" }),
    checkpointFixture({ summary: "Different checkpoint" }),
  ]) {
    expect(new ChatGptCompactionContinuationStore(path).accepts(
      changed.parsed,
      extractChatGptTurnIdentity(changed.parsed),
      changed.source,
    )).toBeFalse();
  }
});

test("persisted checkpoint registry stays bounded and evicts the oldest unused scope", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-compaction-"));
  temporaryRoots.push(root);
  const path = join(root, "compaction-continuations.json");
  const store = new ChatGptCompactionContinuationStore(path);

  for (let index = 0; index < 257; index += 1) {
    const compact = checkpointFixture({
      threadId: `thread_${index}`,
      turnId: `turn_${index}`,
      sourceTurnId: `source_${index}`,
      sourceText: `task_${index}`,
      summary: `summary_${index}`,
      compaction: true,
    });
    store.remember(compact.parsed, extractChatGptTurnIdentity(compact.parsed), [compact.source], compact.summary);
  }

  const persisted = JSON.parse(readFileSync(path, "utf8")) as { checkpoints: unknown[] };
  expect(persisted.checkpoints).toHaveLength(256);
  const oldest = checkpointFixture({ threadId: "thread_0", turnId: "turn_0", sourceTurnId: "source_0", sourceText: "task_0", summary: "summary_0" });
  const newest = checkpointFixture({ threadId: "thread_256", turnId: "turn_256", sourceTurnId: "source_256", sourceText: "task_256", summary: "summary_256" });
  const reloaded = new ChatGptCompactionContinuationStore(path);
  expect(reloaded.accepts(oldest.parsed, extractChatGptTurnIdentity(oldest.parsed), oldest.source)).toBeFalse();
  expect(reloaded.accepts(newest.parsed, extractChatGptTurnIdentity(newest.parsed), newest.source)).toBeTrue();
});
test("corrupt persisted authority is rejected atomically and a later completed compaction repairs it", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-compaction-"));
  temporaryRoots.push(root);
  const path = join(root, "compaction-continuations.json");
  const compact = checkpointFixture({ compaction: true });
  const identity = extractChatGptTurnIdentity(compact.parsed);
  new ChatGptCompactionContinuationStore(path).remember(compact.parsed, identity, [compact.source], compact.summary);

  const persisted = JSON.parse(readFileSync(path, "utf8")) as { version: 1; checkpoints: unknown[] };
  persisted.checkpoints.push({
    key: "not-json",
    summaryHash: "bad",
    sourceHashes: ["bad"],
  });
  writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");

  const continuation = checkpointFixture();
  const recoveringStore = new ChatGptCompactionContinuationStore(path);
  expect(recoveringStore.accepts(
    continuation.parsed,
    extractChatGptTurnIdentity(continuation.parsed),
    continuation.source,
  )).toBeFalse();

  recoveringStore.remember(compact.parsed, identity, [compact.source], compact.summary);
  expect(new ChatGptCompactionContinuationStore(path).accepts(
    continuation.parsed,
    extractChatGptTurnIdentity(continuation.parsed),
    continuation.source,
  )).toBeTrue();
});

test("truncated persistence cannot authorize old state and is repaired by a new completed compaction", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-compaction-"));
  temporaryRoots.push(root);
  const path = join(root, "compaction-continuations.json");
  writeFileSync(path, '{"version":1,"checkpoints":[', "utf8");

  const continuation = checkpointFixture();
  const recoveringStore = new ChatGptCompactionContinuationStore(path);
  expect(recoveringStore.accepts(
    continuation.parsed,
    extractChatGptTurnIdentity(continuation.parsed),
    continuation.source,
  )).toBeFalse();

  const compact = checkpointFixture({ compaction: true });
  recoveringStore.remember(
    compact.parsed,
    extractChatGptTurnIdentity(compact.parsed),
    [compact.source],
    compact.summary,
  );
  expect(new ChatGptCompactionContinuationStore(path).accepts(
    continuation.parsed,
    extractChatGptTurnIdentity(continuation.parsed),
    continuation.source,
  )).toBeTrue();
});
