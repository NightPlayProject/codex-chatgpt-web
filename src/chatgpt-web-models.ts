export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
export const CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";
export const CHATGPT_WEB_LUNA_BACKEND_MODEL = "gpt-5.6-luna";
/** Internal adapter identity for a turn whose ChatGPT model is selected by the user in the launcher. */
export const CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL = "chatgpt-web-zero-risk";
/** Internal adapter identity for the explicitly enabled, Pro-sized Zero Risk context profile. */
export const CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL = "chatgpt-web-zero-risk-pro";

export type ChatGptWebAutomaticBackendModel =
  | typeof CHATGPT_WEB_BACKEND_MODEL
  | typeof CHATGPT_WEB_LUNA_BACKEND_MODEL;
export type ChatGptWebBackendModel =
  | ChatGptWebAutomaticBackendModel
  | ChatGptWebZeroRiskBackendModel;
export type ChatGptWebZeroRiskBackendModel =
  | typeof CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
  | typeof CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;

export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ChatGptWebAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ChatGptWebModelFamily = "5.6" | "6";

/**
 * Canonical Codex context windows for Sol. A browser submission has its own smaller transport
 * envelope below, so raising these windows never authorizes a larger one-message payload.
 */
export const CHATGPT_WEB_INSTANT_CONTEXT_WINDOW = 50_000;
export const CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT = 32_000;
/** Preserve the previously validated Plus visible-message envelope independently of context. */
export const CHATGPT_WEB_INSTANT_MESSAGE_TOKEN_LIMIT = 32_807;
/**
 * Zero Risk keeps one visible ChatGPT conversation across sequential Codex turns. Its fixed route
 * therefore uses the requested three-turn compaction interval without enabling Bigger Context's
 * automatic multipart transport; the user still pastes exactly one incremental prompt per turn.
 */
export const CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW = 41_000 * 3;
export const CHATGPT_WEB_ZERO_RISK_AUTO_COMPACT_TOKEN_LIMIT = 32_000 * 3;
export const CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW = 100_000;
export const CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT = 80_000;
/**
 * Live Plus High goal continuations remained healthy through ~70.7k estimated browser input, then
 * ChatGPT reproducibly accepted the final multipart commit and returned its terminal response-error
 * UI at ~74.6k. Compact High before that unstable band while leaving Medium's previously published
 * 80k trigger and the 100k canonical window unchanged. This is an execution-reliability threshold,
 * not a smaller model context window.
 */
export const CHATGPT_WEB_HIGH_RELIABLE_AUTO_COMPACT_TOKEN_LIMIT = 70_000;
/**
 * Last-resort browser preflight for an already-open/stale Plus High session. Native Codex should
 * normally compact at the lower 70k threshold above; this ceiling keeps an old session from
 * repeatedly submitting the observed ~74.6k terminal-error payload before refreshed catalog
 * metadata can take effect. The last observed successful multipart continuation was ~70.7k.
 */
export const CHATGPT_WEB_HIGH_RELIABLE_BROWSER_INPUT_TOKEN_LIMIT = 72_000;
/**
 * Remote compaction v1 normally preserves up to 20k tokens of recent raw user text in addition to
 * the generated checkpoint. A live Plus High compact at the 400k native threshold produced an
 * 87,149-token next browser turn with that default, immediately tripping the 72k reliability
 * guard. The checkpoint is the canonical condensed history and compaction authority separately
 * hashes the exact source revision, so Standard Context Plus High only needs a small raw-text tail.
 * Keeping 2k tokens leaves roughly 18k tokens more headroom than the codex-rs default while still
 * retaining the newest part of the user's request verbatim.
 */
export const CHATGPT_WEB_HIGH_RELIABLE_COMPACT_RETAINED_TEXT_TOKEN_BUDGET = 2_000;
/** Preserve the previously validated Plus reasoning visible-message envelope. */
export const CHATGPT_WEB_MEDIUM_HIGH_MESSAGE_TOKEN_LIMIT = 81_807;
export const CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT = 211_256;
export const CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 1_048_572;
/** Hidden ChatGPT product prompt and Codex Native schema reserve included in usage estimates. */
export const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;
/** Reserve for each attachment in the final browser message; inert stages carry no images. */
export function chatGptWebImageTokenReserve(detail?: string): number {
  return detail === "original" ? 8_192 : 4_096;
}
/** Legacy per-turn threshold retained by the unchanged manual Zero Risk Pro profile. */
export const CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT = 95_000;
/** Canonical Sol windows for Pro accounts. Keep compaction below the measured browser envelope. */
export const CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW = 120_000;
export const CHATGPT_WEB_PRO_STANDARD_AUTO_COMPACT_TOKEN_LIMIT = CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT;
export const CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW = 128_000;
export const CHATGPT_WEB_PRO_MODEL_AUTO_COMPACT_TOKEN_LIMIT = CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT;
/** Separately measured one-message browser boundaries. */
export const CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103_000;
export const CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT = 104_000;
/**
 * Zero Risk Pro keeps the same three-turn manual conversation budget as the default profile, but
 * sizes each turn from the measured ChatGPT Pro boundary. The launcher cannot verify that the user
 * actually selected Pro, so this profile is exposed only through an explicit user setting.
 */
export const CHATGPT_WEB_ZERO_RISK_PRO_CONTEXT_WINDOW =
  (CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1) * 3;
export const CHATGPT_WEB_ZERO_RISK_PRO_AUTO_COMPACT_TOKEN_LIMIT =
  CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT * 3;
export const CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT = 545_000;
// Rechecked 2026-09-19: Pro-account Medium/High accept 500k characters but the server
// rejects larger messages with HTTP 413 (message_length_exceeds_limit), even below
// the token budget. Composer insertion itself still accepts them. Keep headroom;
// Instant and the Pro model have different bounds, not this reasoning-mode ceiling.
export const CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT = 500_000;
export const CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT = 1_635_000;
/**
 * The underlying Luna model owns this context window. ChatGPT Free's much smaller browser request
 * envelope is enforced separately at the browser boundary; rolling checkpoints keep completed
 * history out of later browser requests without asking Codex to compact its canonical history.
 */
export const CHATGPT_WEB_LUNA_CONTEXT_WINDOW = 1_050_000;
/** Canonical Sol history target used by both Standard and Bigger Context. */
export const CHATGPT_WEB_SOL_CONTEXT_WINDOW = 500_000;
export const CHATGPT_WEB_SOL_AUTO_COMPACT_TOKEN_LIMIT = 400_000;
/** Maximum browser stages Bigger Context may use to carry one canonical 500k transaction. */
export const CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER = 3;

export interface ChatGptWebContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

export interface ChatGptWebTransportLimits {
  browserMessageTokenLimit?: number;
  browserComposerCharLimit?: number;
}

export function isChatGptWebZeroRiskBackendModel(
  model: string,
): model is ChatGptWebZeroRiskBackendModel {
  return model === CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
    || model === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;
}

function contextLimits(
  contextWindow: number,
  autoCompactTokenLimit: number,
): ChatGptWebContextLimits {
  return {
    contextWindow,
    // Codex reports this effective window in its context indicator. Align it with the practical
    // pre-compaction budget instead of exposing an unreachable underlying model window.
    effectiveContextWindowPercent: Math.round((autoCompactTokenLimit / contextWindow) * 100),
    autoCompactTokenLimit,
  };
}

function solContextLimits(
  contextWindow: number,
  autoCompactTokenLimit: number,
): ChatGptWebContextLimits {
  return {
    contextWindow,
    // Codex applies effective_context_window_percent to the usable hard window, not only to the
    // UI indicator. Keep Sol's full model window available so the lower auto-compaction limit has
    // real headroom instead of colliding with the same effective hard ceiling.
    effectiveContextWindowPercent: 100,
    autoCompactTokenLimit,
  };
}

/** Resolve the product limit for the selected visible ChatGPT mode. */
export function resolveChatGptWebContextLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebContextLimits {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    if (backendModel === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL) {
      return contextLimits(
        CHATGPT_WEB_ZERO_RISK_PRO_CONTEXT_WINDOW,
        CHATGPT_WEB_ZERO_RISK_PRO_AUTO_COMPACT_TOKEN_LIMIT,
      );
    }
    return contextLimits(
      CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
      CHATGPT_WEB_ZERO_RISK_AUTO_COMPACT_TOKEN_LIMIT,
    );
  }
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    // Luna carries continuity through a private checkpoint on every completed browser turn. Codex
    // internally clamps this field to 90% of the model window, but the reported active usage is the
    // bounded payload actually sent to ChatGPT and therefore stays far below that threshold.
    return contextLimits(CHATGPT_WEB_LUNA_CONTEXT_WINDOW, CHATGPT_WEB_LUNA_CONTEXT_WINDOW);
  }

  let limits: ChatGptWebContextLimits;
  if (
    !capabilities.proAvailable
    && effort !== "low"
    && effort !== "medium"
    && effort !== "high"
    && !(effort === "xhigh" && capabilities.extraHighAvailable)
  ) {
    throw new Error(`ChatGPT Plus context limit is not defined for unavailable effort: ${effort}`);
  }
  // Standard Context must compact before its browser preflight limit. The 500k canonical window
  // is not a reliable single-message transport size; Bigger Context can keep the 400k interval.
  // Medium and High share one catalog row, so both use High's safer measured trigger.
  const autoCompactTokenLimit = capabilities.experimentalBiggerContext
    ? CHATGPT_WEB_SOL_AUTO_COMPACT_TOKEN_LIMIT
    : capabilities.proAvailable
      ? CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT
      : effort === "low"
        ? CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT
        : CHATGPT_WEB_HIGH_RELIABLE_AUTO_COMPACT_TOKEN_LIMIT;
  limits = solContextLimits(CHATGPT_WEB_SOL_CONTEXT_WINDOW, autoCompactTokenLimit);
  // Bigger Context expands browser transport across multiple acknowledged messages. It does not
  // enlarge Codex's canonical model window: multiplying this value used to advertise 1.5M/1.2M,
  // which let native history outrun the intended 500k/400k compaction boundary and made model
  // switches fail before ChatGPT Web had a chance to compact.
  return limits;
}

/**
 * Resolve the retained browser-input threshold used to start Bigger Context multipart staging.
 * This deliberately stays independent from the native Codex compaction threshold: a 400k native
 * history may be healthy while any one visible ChatGPT submission still needs the smaller,
 * empirically validated transport envelope.
 */
export function resolveChatGptWebBrowserStagingTokenLimit(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): number | undefined {
  if (isChatGptWebZeroRiskBackendModel(backendModel) || backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return undefined;
  }
  if (capabilities.proAvailable) return CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT;
  if (effort === "low") return CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT;
  if (effort === "high") return CHATGPT_WEB_HIGH_RELIABLE_AUTO_COMPACT_TOKEN_LIMIT;
  if (effort === "medium" || (effort === "xhigh" && capabilities.extraHighAvailable)) {
    return CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT;
  }
  throw new Error(`ChatGPT Plus browser staging limit is not defined for unavailable effort: ${effort}`);
}

/** Resolve limits of one visible ChatGPT composer message, independently of model context. */
export function resolveChatGptWebTransportLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebTransportLimits {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) return {};
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) return {};
  if (!capabilities.proAvailable) {
    if (effort === "low") {
      return {
        browserMessageTokenLimit: CHATGPT_WEB_INSTANT_MESSAGE_TOKEN_LIMIT,
        browserComposerCharLimit: CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT,
      };
    }
    if (effort === "medium" || effort === "high" || (effort === "xhigh" && capabilities.extraHighAvailable)) {
      return {
        browserMessageTokenLimit: CHATGPT_WEB_MEDIUM_HIGH_MESSAGE_TOKEN_LIMIT,
        browserComposerCharLimit: CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT,
      };
    }
    throw new Error(`ChatGPT Plus transport limit is not defined for unavailable effort: ${effort}`);
  }
  if (effort === "low") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT,
    };
  }
  if (effort === "max") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT,
    };
  }
  return {
    browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
    browserComposerCharLimit: CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT,
  };
}

/**
 * Visible text that fits one ordinary input after its hidden reserve and images. This is derived
 * from the existing context contract, not a new measured browser limit or a compaction trigger.
 * Bigger Context expands the transaction, never this per-message budget.
 */
export function resolveChatGptWebMessageTokenBudget(
  backendModel: typeof CHATGPT_WEB_BACKEND_MODEL,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
  imageTokens = 0,
): number {
  const { contextWindow } = resolveChatGptWebContextLimits(
    backendModel, effort, { ...capabilities, experimentalBiggerContext: false },
  );
  const { browserMessageTokenLimit } = resolveChatGptWebTransportLimits(backendModel, effort, capabilities);
  return Math.max(0, Math.min(
    contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - imageTokens - 1,
    browserMessageTokenLimit ?? Infinity,
  ));
}

interface ChatGptWebModelRouteBase {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  requiresPro: boolean;
  requiresExtraHigh?: boolean;
  /** Old task identities remain resolvable, but are omitted from the picker. */
  legacy?: boolean;
  /** Omission denotes an immutable route, including all pre-6.0 task identities. */
  supportedCodexEfforts?: readonly ChatGptWebCodexEffort[];
}

export interface ChatGptWebAutomaticModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "automatic";
  backendModel: ChatGptWebAutomaticBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  /** Exact browser family, independent of the generic adapter's context/transport profile. */
  modelFamily?: ChatGptWebModelFamily;
}

export interface ChatGptWebZeroRiskModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "manual";
  backendModel: ChatGptWebZeroRiskBackendModel;
  /** Technical protocol value only; Zero Risk must not use it to choose the ChatGPT model. */
  adapterEffort: "low";
}

export type ChatGptWebModelRoute = ChatGptWebAutomaticModelRoute | ChatGptWebZeroRiskModelRoute;

export interface ChatGptWebAccountCapabilities {
  solAvailable: boolean;
  /** Missing in older saved observations; setup must probe before exposing Extra High. */
  extraHighAvailable?: boolean;
  proAvailable: boolean;
  experimentalBiggerContext?: boolean;
  browserInteractionMode?: "automatic" | "manual";
  zeroRiskProEnabled?: boolean;
}

export const CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE: ChatGptWebZeroRiskModelRoute = {
  slug: "chatgpt-web/zero-risk",
  displayName: "ChatGPT Web — Zero Risk",
  description: "Zero Risk keeps model selection and prompt submission under your control while preserving the native Codex harness.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
};

export const CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE: ChatGptWebZeroRiskModelRoute = {
  slug: "chatgpt-web/zero-risk-pro",
  displayName: "ChatGPT Web — Zero Risk Pro",
  description: "Explicit Pro-sized Zero Risk context; select ChatGPT Pro manually for every turn.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: true,
};

export const CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/luna",
  displayName: "ChatGPT Web — Luna",
  description: "ChatGPT Web Luna for accounts without the Sol model selector.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
  legacy: true,
};

export const CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE: ChatGptWebModelRoute = {
  slug: "chatgpt-web/think",
  displayName: "ChatGPT Web — Think",
  description: "ChatGPT Web Think for Luna-only accounts.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  // The backend model remains Luna. This internal adapter effort distinguishes the explicit
  // Think route after Codex has selected its separate catalog row.
  adapterEffort: "medium",
  requiresPro: false,
  legacy: true,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/gpt-5.6-luna",
  displayName: "GPT-5.6 Luna (Web)",
  description: "ChatGPT Luna. Light selects the ordinary mode; Medium enables Think.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  supportedCodexEfforts: ["low", "medium"],
  requiresPro: false,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
];

/**
 * Preserve the exact pre-6.0 bindings for saved tasks, including the old unpinned Pro route.
 * Native Codex may normalize its technical effort; these identities have always owned the mode.
 */
export const CHATGPT_WEB_LEGACY_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/light",
    displayName: "ChatGPT Web — Instant",
    description: "ChatGPT Web Instant through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/medium",
    displayName: "ChatGPT Web — Medium",
    description: "ChatGPT Web Medium through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/high",
    displayName: "ChatGPT Web — High",
    description: "ChatGPT Web High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "ChatGPT Web — Extra High",
    description: "Account-gated ChatGPT Web Extra High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: false,
    requiresExtraHigh: true,
    legacy: true,
  },
  {
    slug: "chatgpt-web/pro",
    displayName: "ChatGPT Web — Pro",
    description: "Account-gated ChatGPT Pro through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "ultra",
    adapterEffort: "max",
    requiresPro: true,
    legacy: true,
  },
];

/** Group only efforts with identical context and compaction budgets. */
export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/gpt-5.6-sol-instant",
    displayName: "GPT-5.6 Sol Instant (Web)",
    description: "GPT-5.6 Sol Instant through ChatGPT, with its own context and compaction budget.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "low",
    adapterEffort: "low",
    supportedCodexEfforts: ["low"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-sol",
    displayName: "GPT-5.6 Sol (Web)",
    description: "GPT-5.6 Sol through ChatGPT with Medium, High, or account-supported Extra High reasoning.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "high",
    adapterEffort: "high",
    supportedCodexEfforts: ["medium", "high", "xhigh"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-pro",
    displayName: "GPT-5.6 Pro (Web)",
    description: "GPT-5.6 Pro through ChatGPT. The fixed Max effort selects Pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "max",
    adapterEffort: "max",
    supportedCodexEfforts: ["max"],
    requiresPro: true,
  },
  {
    slug: "chatgpt-web/gpt-6-pro",
    displayName: "GPT-6 Pro (Web)",
    description: "GPT-6 Pro through ChatGPT. The fixed Max effort selects Pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "max",
    adapterEffort: "max",
    supportedCodexEfforts: ["max"],
    requiresPro: true,
  },
];

const routesBySlug = new Map(
  [
    CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
    CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
    ...CHATGPT_WEB_LUNA_MODEL_ROUTES,
    ...CHATGPT_WEB_MODEL_ROUTES,
    CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE,
    CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
    ...CHATGPT_WEB_LEGACY_MODEL_ROUTES,
  ]
    .map(route => [route.slug, route]),
);

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

export function availableChatGptWebModelRoutes(
  capabilities: ChatGptWebAccountCapabilities,
  includeLegacy = false,
): readonly ChatGptWebModelRoute[] {
  if (capabilities.browserInteractionMode === "manual") {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    return capabilities.zeroRiskProEnabled
      ? [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE]
      : [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE];
  }
  if (!capabilities.solAvailable) return includeLegacy
    ? [...CHATGPT_WEB_LUNA_MODEL_ROUTES, CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE, CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE]
    : CHATGPT_WEB_LUNA_MODEL_ROUTES;
  const candidates = includeLegacy
    ? [...CHATGPT_WEB_MODEL_ROUTES, ...CHATGPT_WEB_LEGACY_MODEL_ROUTES]
    : CHATGPT_WEB_MODEL_ROUTES;
  return candidates.filter(route =>
    (!route.requiresPro || capabilities.proAvailable)
    && (!route.requiresExtraHigh || capabilities.extraHighAvailable));
}

export function chatGptWebRouteEfforts(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): readonly ChatGptWebCodexEffort[] {
  return (route.supportedCodexEfforts ?? [route.codexEffort])
    .filter(effort => effort !== "xhigh" || capabilities.extraHighAvailable === true);
}

export function requireChatGptWebModelRoute(
  modelId: string,
  capabilities: ChatGptWebAccountCapabilities,
  reasoning?: string,
): ChatGptWebModelRoute {
  if (capabilities.browserInteractionMode === "manual" && capabilities.experimentalBiggerContext) {
    throw new Error("Zero Risk does not support Bigger Context");
  }
  const route = routesBySlug.get(modelId);
  if (!route) throw new Error(`ChatGPT web model is not enabled: ${modelId}`);
  if (capabilities.browserInteractionMode === "manual") {
    if (route.interactionMode !== "manual") {
      throw new Error(`${route.displayName} is not available while Zero Risk is enabled`);
    }
    if (route === CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE && !capabilities.zeroRiskProEnabled) {
      throw new Error(`${route.displayName} is not enabled in Zero Risk model settings`);
    }
    return route;
  }
  if (route.interactionMode === "manual") {
    throw new Error(`${route.displayName} is only available while Zero Risk is enabled`);
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (capabilities.solAvailable) {
      throw new Error(`${route.displayName} is only available for Luna-only accounts`);
    }
    return resolveRouteEffort(route, capabilities, reasoning);
  }
  if (!capabilities.solAvailable) {
    throw new Error(`${route.displayName} is not available for this Luna-only account`);
  }
  if ((route.requiresPro && !capabilities.proAvailable)
    || (route.requiresExtraHigh && !capabilities.extraHighAvailable)) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  return resolveRouteEffort(route, capabilities, reasoning);
}

function resolveRouteEffort(
  route: ChatGptWebAutomaticModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
  reasoning?: string,
): ChatGptWebAutomaticModelRoute {
  if (!route.supportedCodexEfforts) return route;
  const effort = reasoning ?? route.codexEffort;
  if (!chatGptWebRouteEfforts(route, capabilities).includes(effort as ChatGptWebCodexEffort)) {
    throw new Error(`${route.displayName} does not support effort ${JSON.stringify(effort)} for this account`);
  }
  if (effort === route.codexEffort) return route;
  return { ...route, codexEffort: effort as ChatGptWebCodexEffort, adapterEffort: effort as ChatGptWebAdapterEffort };
}
