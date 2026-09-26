import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { isNativeGoalContextItem } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { matchingCompactionCheckpoint } from "./compaction-continuation";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

/** Durable lineage only. Goal/runtime text is intentionally absent from this record. */
export interface GoalContinuation {
  turnId: string;
  sourceRevision: string;
  checkpointId: string;
  goalRevision: string;
  goalId: string;
}

interface PersistedGoalContinuation {
  key: string;
  continuation: GoalContinuation;
}

interface PersistedGoalContinuationFile {
  version: 2;
  continuations: PersistedGoalContinuation[];
}

export interface TrustedNativeGoalContext {
  objective: string;
  goalRevision: string;
  runtimeItemId: string;
  inputIndex: number;
}

export interface AuthorizedGoalContinuation {
  continuation: GoalContinuation;
  /** Present only when this exact request carries fresh current-turn native goal steering. */
  currentContext?: TrustedNativeGoalContext;
}

type NativeGoalEvidence =
  | { state: "absent" }
  | { state: "invalid" }
  | ({ state: "valid" } & TrustedNativeGoalContext);

const MAX_GOAL_CONTINUATIONS = 256;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  return JSON.stringify([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning]);
}

function sourceRevisionDigest(source: ChatGptTurnUserRevision): string {
  return digest(["chatgpt-human-user-revision-v1", source.turnId ?? null, source.itemId ?? null, source.content]);
}

function sourceText(source: ChatGptTurnUserRevision): string | undefined {
  const content = source.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const part = content[0];
  if (!part || typeof part !== "object" || Array.isArray(part)) return undefined;
  const value = part as { type?: unknown; text?: unknown };
  return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
    ? value.text
    : undefined;
}

/**
 * Native Codex records the user-triggering `/goal ...` command as ordinary `user.text` on the
 * first goal turn. Automatic goal rounds then append a trusted `goal.internal_context` wrapper
 * under a new turn id. That command is valid origin authority only when its exact argument matches
 * the trusted objective carried by the current native wrapper; arbitrary historical user text can
 * never enter this path.
 */
function matchingNativeGoalCommandSource(
  source: ChatGptTurnUserRevision,
  evidence: Extract<NativeGoalEvidence, { state: "valid" }>,
): boolean {
  return nativeGoalCommandRevision(source) === evidence.goalRevision;
}

function nativeGoalCommandRevision(source: ChatGptTurnUserRevision): string | undefined {
  const text = sourceText(source)?.replace(/\r\n?/g, "\n").trim();
  if (!text?.startsWith("/goal ")) return undefined;
  const objective = text.slice("/goal ".length).trim();
  return objective.length > 0
    ? digest(["chatgpt-native-goal-objective-v1", objective])
    : undefined;
}

function nativeGoalCommandOriginId(sourceRevision: string, goalRevision: string): string {
  return digest(["chatgpt-native-goal-command-origin-v1", sourceRevision, goalRevision]);
}

function goalContinuationId(
  scopeKey: string,
  sourceRevision: string,
  checkpointId: string,
  goalRevision: string,
): string {
  return digest(["chatgpt-goal-continuation-v2", scopeKey, sourceRevision, checkpointId, goalRevision]);
}

function itemTurnId(item: Record<string, unknown>): string | undefined {
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const turnId = (metadata as { turn_id?: unknown }).turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

function hasNativeGoalKind(item: Record<string, unknown>): boolean {
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const kinds = (metadata as { content_item_kinds?: unknown }).content_item_kinds;
  return Array.isArray(kinds) && kinds.includes("goal.internal_context");
}

/** Any current-turn native goal claim, including a malformed one, is an authority-bearing signal. */
export function hasCurrentNativeGoalClaim(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): boolean {
  if (!identity.turnId) return false;
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return false;
  return input.some(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return hasNativeGoalKind(item) && itemTurnId(item) === identity.turnId;
  });
}

function nativeGoalRuntimeText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const part = content[0];
  if (!part || typeof part !== "object" || Array.isArray(part)) return undefined;
  const block = part as { type?: unknown; text?: unknown };
  return block.type === "input_text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * Codex owns the runtime wrapper; only the inner objective is user-selected task data. Keep the
 * wrapper out of browser history and extract exactly one unambiguous objective from the native
 * wire. The surrounding budget/progress scaffold intentionally does not participate in the goal
 * revision because Codex regenerates it between provider rounds.
 */
function nativeGoalObjective(item: Record<string, unknown>): string | undefined {
  const raw = nativeGoalRuntimeText(item);
  if (raw === undefined) return undefined;
  const text = raw.replace(/\r\n?/g, "\n").trim();
  const outerOpen = '<codex_internal_context source="goal">';
  const outerClose = "</codex_internal_context>";
  if (!text.startsWith(outerOpen) || !text.endsWith(outerClose)) return undefined;
  const objectiveOpen = "<objective>";
  const objectiveClose = "</objective>";
  const openIndex = text.indexOf(objectiveOpen);
  const closeIndex = text.indexOf(objectiveClose);
  if (openIndex < outerOpen.length || closeIndex <= openIndex + objectiveOpen.length) return undefined;
  if (text.indexOf(objectiveOpen, openIndex + objectiveOpen.length) !== -1
    || text.indexOf(objectiveClose, closeIndex + objectiveClose.length) !== -1) return undefined;
  let objective = text.slice(openIndex + objectiveOpen.length, closeIndex);
  // Codex frames the objective on its own lines. Remove only those framing newlines so deliberate
  // user whitespace inside the objective remains part of the semantic revision.
  if (objective.startsWith("\n")) objective = objective.slice(1);
  if (objective.endsWith("\n")) objective = objective.slice(0, -1);
  return objective.trim().length > 0 ? objective : undefined;
}

/**
 * Current Codex Responses requests expose no stable thread-level `goalId`. The native-generated
 * wrapper id is therefore current-message provenance only; durable identity is bridge-owned and
 * binds a hash of the strictly extracted objective to the exact checkpoint/source/scope lineage.
 */
function nativeGoalEvidence(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): NativeGoalEvidence {
  if (!identity.turnId) return { state: "invalid" };
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return { state: "invalid" };
  const current: TrustedNativeGoalContext[] = [];
  let sawGoalContext = false;
  for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
    const value = input[inputIndex];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (!hasNativeGoalKind(item)) continue;
    sawGoalContext = true;
    if (itemTurnId(item) !== identity.turnId) continue;
    if (item.type !== "message" || item.role !== "user" || !isNativeGoalContextItem(item)) {
      return { state: "invalid" };
    }
    if (typeof item.id !== "string" || item.id.length === 0) return { state: "invalid" };
    const objective = nativeGoalObjective(item);
    if (objective === undefined) return { state: "invalid" };
    current.push({
      objective,
      goalRevision: digest(["chatgpt-native-goal-objective-v1", objective]),
      runtimeItemId: item.id,
      inputIndex,
    });
  }
  if (current.length === 1) return { state: "valid", ...current[0]! };
  if (current.length > 1) return { state: "invalid" };
  if (sawGoalContext) return { state: "invalid" };
  return { state: "absent" };
}

/**
 * Steering appends a human/direct-parent revision after Codex's current goal runtime wrapper.
 * Accept that shape only when the wrapper is the single well-formed current goal claim and it
 * actually precedes the newer instruction. Malformed, duplicate, or later goal claims remain
 * ambiguous and must continue to fail closed at the caller.
 */
export function hasTrustedCurrentNativeGoalBeforeInput(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  inputIndex: number,
): boolean {
  const evidence = nativeGoalEvidence(parsed, identity);
  return evidence.state === "valid" && evidence.inputIndex < inputIndex;
}

function validateScopeKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid persisted ChatGPT goal scope");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid persisted ChatGPT goal scope");
  }
  if (!Array.isArray(parsed) || parsed.length !== 4
    || typeof parsed[0] !== "string" || !parsed[0]
    || typeof parsed[1] !== "string" || !parsed[1]
    || typeof parsed[2] !== "string" || !parsed[2]
    || (parsed[3] !== null && typeof parsed[3] !== "string")) {
    throw new Error("Invalid persisted ChatGPT goal scope");
  }
  return value;
}

function validateHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`Invalid persisted ChatGPT goal ${field}`);
  }
  return value;
}

function validateContinuation(value: unknown): GoalContinuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted ChatGPT goal continuation");
  }
  const raw = value as Partial<GoalContinuation>;
  if (typeof raw.turnId !== "string" || raw.turnId.length === 0 || raw.turnId.length > 256) {
    throw new Error("Invalid persisted ChatGPT goal turn id");
  }
  return {
    turnId: raw.turnId,
    sourceRevision: validateHash(raw.sourceRevision, "source revision"),
    checkpointId: validateHash(raw.checkpointId, "checkpoint id"),
    goalRevision: validateHash(raw.goalRevision, "goal revision"),
    goalId: validateHash(raw.goalId, "goal id"),
  };
}

function validateEntry(value: unknown): [string, GoalContinuation] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted ChatGPT goal entry");
  }
  const raw = value as Partial<PersistedGoalContinuation>;
  const key = validateScopeKey(raw.key);
  const continuation = validateContinuation(raw.continuation);
  const parsedScope = JSON.parse(key) as [string, string, string, string | null];
  if (parsedScope[1] !== continuation.turnId) {
    throw new Error("Persisted ChatGPT goal turn does not match its scope");
  }
  if (continuation.goalId !== goalContinuationId(
    key,
    continuation.sourceRevision,
    continuation.checkpointId,
    continuation.goalRevision,
  )) {
    throw new Error("Persisted ChatGPT goal id does not match its lineage");
  }
  return [key, continuation];
}

/** Restart-safe authorization for a native `/goal` turn to continue one proven human revision. */
export class ChatGptGoalContinuationStore {
  private loaded = false;
  private readonly continuations = new Map<string, GoalContinuation>();

  constructor(private readonly path?: string) {}

  resolve(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
    source: ChatGptTurnUserRevision,
  ): AuthorizedGoalContinuation | undefined {
    const key = scope(parsed, identity);
    if (!key || !identity.turnId || !source.turnId || source.turnId === identity.turnId) return undefined;
    this.load();

    const sourceRevision = sourceRevisionDigest(source);
    const existing = this.continuations.get(key);
    if (existing) {
      if (existing.turnId !== identity.turnId || existing.sourceRevision !== sourceRevision) return undefined;
      const evidence = nativeGoalEvidence(parsed, identity);
      if (evidence.state === "invalid") return undefined;
      if (evidence.state === "valid" && evidence.goalRevision !== existing.goalRevision) return undefined;
      const commandRevision = nativeGoalCommandRevision(source);
      const matchingCommandOrigin = commandRevision === existing.goalRevision
        && existing.checkpointId === nativeGoalCommandOriginId(sourceRevision, existing.goalRevision);
      if (!matchingCommandOrigin && !matchingCompactionCheckpoint(parsed, identity, source, existing.checkpointId)) return undefined;
      this.touch(key, existing);
      return {
        continuation: existing,
        ...(evidence.state === "valid" ? { currentContext: {
          objective: evidence.objective,
          goalRevision: evidence.goalRevision,
          runtimeItemId: evidence.runtimeItemId,
          inputIndex: evidence.inputIndex,
        } } : {}),
      };
    }

    const evidence = nativeGoalEvidence(parsed, identity);
    if (evidence.state !== "valid") return undefined;
    const checkpoint = matchingCompactionCheckpoint(parsed, identity, source);
    const commandOriginId = matchingNativeGoalCommandSource(source, evidence)
      ? nativeGoalCommandOriginId(sourceRevision, evidence.goalRevision)
      : undefined;
    if (!checkpoint && !commandOriginId) return undefined;
    const checkpointId = checkpoint?.checkpointId ?? commandOriginId!;
    const continuation: GoalContinuation = {
      turnId: identity.turnId,
      sourceRevision,
      checkpointId,
      goalRevision: evidence.goalRevision,
      // Bridge-owned durable identity. The native runtime wrapper id is intentionally excluded:
      // Codex may regenerate that wrapper across provider rounds and does not expose a stable goal
      // id on the Responses wire. The exact turn + human revision + completed checkpoint + trusted
      // objective revision is the strongest authority available at this boundary.
      goalId: goalContinuationId(key, sourceRevision, checkpointId, evidence.goalRevision),
    };
    this.continuations.set(key, continuation);
    while (this.continuations.size > MAX_GOAL_CONTINUATIONS) {
      const oldest = this.continuations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.continuations.delete(oldest);
    }
    this.persist();
    return {
      continuation,
      currentContext: {
        objective: evidence.objective,
        goalRevision: evidence.goalRevision,
        runtimeItemId: evidence.runtimeItemId,
        inputIndex: evidence.inputIndex,
      },
    };
  }

  authorize(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
    source: ChatGptTurnUserRevision,
  ): boolean {
    return this.resolve(parsed, identity, source) !== undefined;
  }

  private touch(key: string, continuation: GoalContinuation): void {
    this.continuations.delete(key);
    this.continuations.set(key, continuation);
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    if (!this.path || !existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    const loaded = new Map<string, GoalContinuation>();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PersistedGoalContinuationFile>;
      if (parsed.version !== 2 || !Array.isArray(parsed.continuations)
        || parsed.continuations.length > MAX_GOAL_CONTINUATIONS) {
        throw new Error("Invalid persisted ChatGPT goal store envelope");
      }
      for (const raw of parsed.continuations) {
        const [key, continuation] = validateEntry(raw);
        if (loaded.has(key)) throw new Error("Duplicate persisted ChatGPT goal scope");
        loaded.set(key, continuation);
      }
    } catch {
      // Goal persistence is authorization evidence. Corruption discards all loaded authority; a
      // later request carrying fresh native goal metadata plus a valid checkpoint may repair it.
      this.continuations.clear();
      this.loaded = true;
      return;
    }
    this.continuations.clear();
    for (const [key, continuation] of loaded) this.continuations.set(key, continuation);
    this.loaded = true;
  }

  private persist(): void {
    if (!this.path) return;
    const payload: PersistedGoalContinuationFile = {
      version: 2,
      continuations: [...this.continuations].map(([key, continuation]) => ({ key, continuation })),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

const defaultStore = new ChatGptGoalContinuationStore();
const requestStores = new WeakMap<CodexParsedRequest, ChatGptGoalContinuationStore>();

export function bindGoalContinuationStore(
  parsed: CodexParsedRequest,
  store: ChatGptGoalContinuationStore,
): void {
  requestStores.set(parsed, store);
}

function storeFor(parsed: CodexParsedRequest): ChatGptGoalContinuationStore {
  return requestStores.get(parsed) ?? defaultStore;
}

/** Derived transport requests must keep the same server-owned continuation authority. */
export function inheritGoalContinuationStore(source: CodexParsedRequest, target: CodexParsedRequest): void {
  bindGoalContinuationStore(target, storeFor(source));
}

export function authorizeGoalContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  return storeFor(parsed).authorize(parsed, identity, source);
}

export function resolveGoalContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): AuthorizedGoalContinuation | undefined {
  return storeFor(parsed).resolve(parsed, identity, source);
}
