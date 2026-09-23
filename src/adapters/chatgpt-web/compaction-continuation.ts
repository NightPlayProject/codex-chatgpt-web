import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
  source?: ChatGptTurnUserRevision;
}

interface PersistedCheckpoint {
  key: string;
  summaryHash: string;
  sourceHashes: string[];
}

interface PersistedCheckpointFile {
  version: 1;
  checkpoints: PersistedCheckpoint[];
}

export interface ChatGptCompactionCheckpointMatch {
  checkpointId: string;
}

const MAX_CHECKPOINTS = 256;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  return JSON.stringify([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return digest([source.turnId, source.content]);
}

function checkpointId(key: string, checkpoint: CompletedCheckpoint): string {
  return digest([
    "chatgpt-compaction-checkpoint-v1",
    key,
    checkpoint.summaryHash,
    [...checkpoint.sourceHashes].sort(),
  ]);
}

function parsedScopeKey(value: string): [string, string, string, string | null] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4
      || typeof parsed[0] !== "string" || !parsed[0]
      || typeof parsed[1] !== "string" || !parsed[1]
      || typeof parsed[2] !== "string" || !parsed[2]
      || (parsed[3] !== null && typeof parsed[3] !== "string")) return undefined;
    return parsed as [string, string, string, string | null];
  } catch {
    return undefined;
  }
}

function latestCompactionSummary(parsed: CodexParsedRequest): string | undefined {
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      return typeof item.encrypted_content === "string"
        ? decodeCompactionSummary(item.encrypted_content) ?? undefined
        : undefined;
    }
    if (item.role !== "user") continue;
    const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.map(part => part?.text ?? "").join("\n") : "";
    if (isReadableCompactionSummaryText(text)) return text.slice(SUMMARY_PREFIX.length + 1);
  }
  return undefined;
}

function validateScopeKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid persisted ChatGPT compaction scope");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid persisted ChatGPT compaction scope");
  }
  if (!Array.isArray(parsed) || parsed.length !== 4
    || typeof parsed[0] !== "string" || !parsed[0]
    || typeof parsed[1] !== "string" || !parsed[1]
    || typeof parsed[2] !== "string" || !parsed[2]
    || (parsed[3] !== null && typeof parsed[3] !== "string")) {
    throw new Error("Invalid persisted ChatGPT compaction scope");
  }
  return value;
}

function validateHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`Invalid persisted ChatGPT compaction ${field}`);
  }
  return value;
}

function validateCheckpoint(value: unknown): [string, CompletedCheckpoint] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted ChatGPT compaction checkpoint");
  }
  const raw = value as Partial<PersistedCheckpoint>;
  const key = validateScopeKey(raw.key);
  const summaryHash = validateHash(raw.summaryHash, "summary hash");
  if (!Array.isArray(raw.sourceHashes) || raw.sourceHashes.length === 0
    || raw.sourceHashes.length > 8) {
    throw new Error("Invalid persisted ChatGPT compaction source hashes");
  }
  const sourceHashes = new Set(raw.sourceHashes.map(hash => validateHash(hash, "source hash")));
  if (sourceHashes.size !== raw.sourceHashes.length) {
    throw new Error("Invalid persisted ChatGPT compaction source hashes");
  }
  return [key, { summaryHash, sourceHashes }];
}

/**
 * Durable evidence of compaction handoffs actually completed by this bridge.
 *
 * Only hashes and native identity scope are persisted; prompt/summary plaintext never leaves the
 * normal Codex/ChatGPT histories. A restart may reload previously authenticated handoffs, but an
 * arbitrary summary-looking message can never create new authority.
 */
export class ChatGptCompactionContinuationStore {
  private loaded = false;
  private readonly checkpoints = new Map<string, CompletedCheckpoint>();

  constructor(private readonly path?: string) {}

  remember(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
    sources: readonly ChatGptTurnUserRevision[],
    summary: string,
  ): void {
    const key = scope(parsed, identity);
    if (!key || !parsed._compactionRequest || !summary || !sources[0]) return;
    this.load();
    this.checkpoints.delete(key);
    this.checkpoints.set(key, {
      summaryHash: digest(summary),
      sourceHashes: new Set(sources.map(sourceDigest)),
      source: structuredClone(sources[0]),
    });
    while (this.checkpoints.size > MAX_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      this.checkpoints.delete(oldest);
    }
    this.persist();
  }

  accepts(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
    source: ChatGptTurnUserRevision,
  ): boolean {
    const key = scope(parsed, identity);
    if (!key) return false;
    this.load();
    const checkpoint = this.checkpoints.get(key);
    if (!checkpoint || !checkpoint.sourceHashes.has(sourceDigest(source))) return false;
    const summary = latestCompactionSummary(parsed);
    return summary !== undefined && this.acceptsSummary(key, checkpoint, summary);
  }

  recover(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
  ): { source: ChatGptTurnUserRevision; summaryIndex: number } | undefined {
    const key = scope(parsed, identity);
    if (!key) return undefined;
    this.load();
    const checkpoint = this.checkpoints.get(key);
    if (!checkpoint?.source) return undefined;
    const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
    if (!Array.isArray(input)) return undefined;
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index] as Record<string, unknown> | null;
      if (!item || typeof item !== "object") continue;
      let summary: string | null;
      if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
        summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
      } else {
        if (item.type !== "message" || item.role !== "user") continue;
        const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
          ? item.content.map(part => (part as { text?: string } | null)?.text ?? "").join("\n") : "";
        if (!isReadableCompactionSummaryText(text)) continue;
        summary = text.slice(SUMMARY_PREFIX.length + 1);
      }
      const owner = (item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id;
      if (owner !== undefined && owner !== identity.turnId) return undefined;
      if (summary === null || !this.acceptsSummary(key, checkpoint, summary)) return undefined;
      return { source: structuredClone(checkpoint.source), summaryIndex: index };
    }
    return undefined;
  }

  /**
   * Resolve a prior completed checkpoint for a native `/goal` turn without broadening ordinary
   * continuation authority. The current request must carry the exact checkpoint summary and exact
   * human source representation; thread/model/effort also stay bound. Only the old compaction
   * `turn_id` is intentionally allowed to differ because native `/goal` starts a new turn.
   */
  matchingCheckpoint(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
    source: ChatGptTurnUserRevision,
    expectedCheckpointId?: string,
  ): ChatGptCompactionCheckpointMatch | undefined {
    if (!identity.threadId || !identity.turnId) return undefined;
    const summary = latestCompactionSummary(parsed);
    if (summary === undefined) return undefined;
    const summaryHash = digest(summary);
    const sourceHash = sourceDigest(source);
    this.load();
    const entries = [...this.checkpoints.entries()];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, checkpoint] = entries[index]!;
      const checkpointScope = parsedScopeKey(key);
      if (!checkpointScope) continue;
      const [threadId, _turnId, modelId, reasoning] = checkpointScope;
      if (threadId !== identity.threadId
        || modelId !== parsed.modelId
        || reasoning !== (parsed.options.reasoning ?? null)
        || checkpoint.summaryHash !== summaryHash
        || !checkpoint.sourceHashes.has(sourceHash)) continue;
      const id = checkpointId(key, checkpoint);
      if (expectedCheckpointId !== undefined && id !== expectedCheckpointId) continue;
      // Successful goal use is real use of the exact checkpoint, so retain normal MRU semantics.
      this.checkpoints.delete(key);
      this.checkpoints.set(key, checkpoint);
      this.persist();
      return { checkpointId: id };
    }
    return undefined;
  }

  private acceptsSummary(key: string, checkpoint: CompletedCheckpoint, summary: string): boolean {
    if (digest(summary) !== checkpoint.summaryHash) return false;
    // A long-running continuation does not become invalid merely because time passed. Keep the
    // bounded registry ordered by actual use instead of expiring a still-active native turn.
    this.checkpoints.delete(key);
    this.checkpoints.set(key, checkpoint);
    this.persist();
    return true;
  }

  private load(): void {
    if (this.loaded) return;
    if (!this.path || !existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    const loaded = new Map<string, CompletedCheckpoint>();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PersistedCheckpointFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.checkpoints)
        || parsed.checkpoints.length > MAX_CHECKPOINTS) {
        throw new Error("Invalid persisted ChatGPT compaction store envelope");
      }
      for (const raw of parsed.checkpoints) {
        const [key, checkpoint] = validateCheckpoint(raw);
        if (loaded.has(key)) throw new Error("Duplicate persisted ChatGPT compaction scope");
        loaded.set(key, checkpoint);
      }
    } catch {
      // Persistence is only evidence for a previously completed handoff. Corruption must never
      // leave partially validated authority resident, nor should it prevent a future completed
      // compaction from establishing fresh authority and atomically repairing the file.
      this.checkpoints.clear();
      this.loaded = true;
      return;
    }
    this.checkpoints.clear();
    for (const [key, checkpoint] of loaded) this.checkpoints.set(key, checkpoint);
    this.loaded = true;
  }

  private persist(): void {
    if (!this.path) return;
    const payload: PersistedCheckpointFile = {
      version: 1,
      checkpoints: [...this.checkpoints].map(([key, checkpoint]) => ({
        key,
        summaryHash: checkpoint.summaryHash,
        sourceHashes: [...checkpoint.sourceHashes],
      })),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

// Direct in-process calls (mostly tests) preserve the historical memory-only behavior. Production
// binds every parsed request to the server-owned durable store before any revision validation.
const defaultStore = new ChatGptCompactionContinuationStore();
const requestStores = new WeakMap<CodexParsedRequest, ChatGptCompactionContinuationStore>();

export function bindCompactionContinuationStore(
  parsed: CodexParsedRequest,
  store: ChatGptCompactionContinuationStore,
): void {
  requestStores.set(parsed, store);
}

function storeFor(parsed: CodexParsedRequest): ChatGptCompactionContinuationStore {
  return requestStores.get(parsed) ?? defaultStore;
}

/** Derived transport requests must keep the same server-owned checkpoint authority. */
export function inheritCompactionContinuationStore(source: CodexParsedRequest, target: CodexParsedRequest): void {
  bindCompactionContinuationStore(target, storeFor(source));
}

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  storeFor(parsed).remember(parsed, identity, sources, summary);
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  return storeFor(parsed).accepts(parsed, identity, source);
}

export function recoverCompactionInstruction(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { source: ChatGptTurnUserRevision; summaryIndex: number } | undefined {
  return storeFor(parsed).recover(parsed, identity);
}

export function matchingCompactionCheckpoint(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
  expectedCheckpointId?: string,
): ChatGptCompactionCheckpointMatch | undefined {
  return storeFor(parsed).matchingCheckpoint(parsed, identity, source, expectedCheckpointId);
}
