import { ChatGptWebAdapterError } from "./adapter-error";

/** Maximum number of automatic browser-turn retries after the initial send. */
export const MAX_CHATGPT_WEB_TURN_RETRIES = 3;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;
export const CHATGPT_WEB_RATE_LIMIT_COOLDOWN_MS = 2 * 60_000;

interface RetryBudgetEntry {
  retries: number;
  updatedAt: number;
  lastError: {
    message: string;
    status: number;
    errorType: string;
    code: string;
  };
}

function exhaustedError(entry: RetryBudgetEntry): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `${entry.lastError.message} ChatGPT remained unavailable after several attempts.`,
    {
      status: entry.lastError.status,
      errorType: entry.lastError.errorType,
      code: entry.lastError.code,
      retryable: false,
    },
  );
}

/**
 * Tracks only retryable ChatGPT browser failures across adapter instances. The HTTP bridge creates
 * one adapter per request, so this process-local budget must live outside createChatGptWebAdapter.
 */
export class ChatGptWebTurnRetryPolicy {
  private readonly entries = new Map<string, RetryBudgetEntry>();

  constructor(private readonly ttlMs = RETRY_BUDGET_TTL_MS) {}

  recordRetryableFailure(key: string, error: ChatGptWebAdapterError, now = Date.now()): ChatGptWebAdapterError {
    if (error.status === 429 || error.code === "rate_limit_exceeded") {
      const scope = retryScope(key);
      if (scope) return chatGptWebRateLimitController.recordRateLimit(scope, key, error, now);
    }
    chatGptWebRateLimitController.recordRequestSettled(retryScope(key) ?? "", now);
    this.prune(now);
    const previous = this.entries.get(key);
    const entry: RetryBudgetEntry = {
      retries: (previous?.retries ?? 0) + 1,
      updatedAt: now,
      lastError: {
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        code: error.code,
      },
    };
    this.entries.set(key, entry);
    return entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : error;
  }

  exhaustedError(key: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    return entry && entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : undefined;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt >= this.ttlMs) this.entries.delete(key);
    }
  }
}

export const chatGptWebTurnRetryPolicy = new ChatGptWebTurnRetryPolicy();

interface RateLimitScopeState {
  cooldownUntil: number;
  recoveryProbeInFlight: boolean;
}

interface TerminalRateLimitEntry {
  expiresAt: number;
  error: ChatGptWebAdapterError;
}

export function isChatGptWebRateLimitError(error: unknown): error is ChatGptWebAdapterError {
  return error instanceof ChatGptWebAdapterError
    && (error.status === 429 || error.code === "rate_limit_exceeded");
}

function terminalRateLimitError(error: ChatGptWebAdapterError, cooldownMs: number): ChatGptWebAdapterError {
  const seconds = Math.max(1, Math.ceil(cooldownMs / 1_000));
  return new ChatGptWebAdapterError(
    `${error.message} Codex paused new ChatGPT Web browser sends for this account profile for about ${seconds} seconds. This turn will not be automatically resubmitted.`,
    {
      status: error.status,
      errorType: error.errorType,
      code: error.code,
      retryable: false,
    },
  );
}

function retryScope(key: string): string | undefined {
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : undefined;
}

/**
 * Process-local circuit breaker for ChatGPT account/profile rate limits. A rate limit is terminal
 * for the exact native turn, blocks new browser sends for the affected provider scope during the
 * cooldown, and keeps concurrency at one until a post-cooldown probe succeeds.
 */
export class ChatGptWebRateLimitController {
  private readonly scopes = new Map<string, RateLimitScopeState>();
  private readonly terminalTurns = new Map<string, TerminalRateLimitEntry>();

  constructor(
    private readonly cooldownMs = CHATGPT_WEB_RATE_LIMIT_COOLDOWN_MS,
    private readonly turnTtlMs = RETRY_BUDGET_TTL_MS,
  ) {}

  recordRateLimit(
    scope: string,
    turnKey: string,
    error: ChatGptWebAdapterError,
    now = Date.now(),
  ): ChatGptWebAdapterError {
    this.prune(now);
    const terminal = terminalRateLimitError(error, this.cooldownMs);
    this.scopes.set(scope, { cooldownUntil: now + this.cooldownMs, recoveryProbeInFlight: false });
    this.terminalTurns.set(turnKey, { expiresAt: now + this.turnTtlMs, error: terminal });
    return terminal;
  }

  terminalTurnError(turnKey: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const terminal = this.terminalTurns.get(turnKey)?.error;
    if (terminal) return terminal;
    const separator = turnKey.indexOf(":");
    const scope = separator > 0 ? turnKey.slice(0, separator) : undefined;
    return scope ? this.beginRequest(scope, now) : undefined;
  }

  cooldownError(scope: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const state = this.scopes.get(scope);
    if (!state || now >= state.cooldownUntil) return undefined;
    const seconds = Math.max(1, Math.ceil((state.cooldownUntil - now) / 1_000));
    return new ChatGptWebAdapterError(
      `ChatGPT Web is cooling down after a rate limit. Retry in about ${seconds} seconds; no browser request was sent.`,
      {
        status: 429,
        errorType: "rate_limit_error",
        code: "rate_limit_exceeded",
        retryable: false,
      },
    );
  }

  beginRequest(scope: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const state = this.scopes.get(scope);
    if (!state) return undefined;
    if (now < state.cooldownUntil) return this.cooldownError(scope, now);
    if (state.recoveryProbeInFlight) {
      return new ChatGptWebAdapterError(
        "ChatGPT Web is recovering from a rate limit. One recovery request is already in progress; no browser request was sent.",
        {
          status: 429,
          errorType: "rate_limit_error",
          code: "rate_limit_exceeded",
          retryable: false,
        },
      );
    }
    state.recoveryProbeInFlight = true;
    return undefined;
  }

  isRecovering(scope: string, now = Date.now()): boolean {
    this.prune(now);
    return this.scopes.has(scope);
  }

  recordSuccess(scope: string, now = Date.now()): void {
    this.prune(now);
    const state = this.scopes.get(scope);
    if (state && now >= state.cooldownUntil) this.scopes.delete(scope);
  }

  recordRequestSettled(scope: string, now = Date.now()): void {
    this.prune(now);
    const state = this.scopes.get(scope);
    if (state && now >= state.cooldownUntil) state.recoveryProbeInFlight = false;
  }

  clearScope(scope: string): void {
    this.scopes.delete(scope);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.terminalTurns) {
      if (now >= entry.expiresAt) this.terminalTurns.delete(key);
    }
  }
}

export const chatGptWebRateLimitController = new ChatGptWebRateLimitController();
