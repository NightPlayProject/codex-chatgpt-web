const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { URL, URLSearchParams } = require("node:url");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const {
  launchOfficialCodexApplication,
  listOfficialCodexProcesses,
  resolveOfficialCodexIdentity,
} = require("./official-codex-wallpapers.cjs");

const execFileAsync = promisify(execFile);
const MAX_ACTIVITY_EVENTS = 1_000;
const ACTIVITY_DAYS = 84;
const PROCESS_WAIT_TIMEOUT_MS = 15_000;
const PROCESS_WAIT_INTERVAL_MS = 250;
const CHATGPT_BACKEND_API = "https://chatgpt.com/backend-api";
const CHATGPT_USAGE_URL = `${CHATGPT_BACKEND_API}/wham/usage`;
const CHATGPT_PROFILE_USAGE_URL = `${CHATGPT_BACKEND_API}/wham/profiles/me`;
const CHATGPT_RESET_CREDITS_URL = `${CHATGPT_BACKEND_API}/wham/rate-limit-reset-credits`;
const CHATGPT_REQUEST_TIMEOUT_MS = 10_000;
const CHATGPT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_DEFAULT_PORT = 1455;
const OPENAI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function stringValue(value, maximum = 512) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function dateValue(value) {
  const text = stringValue(value, 128);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return new Date(text).toISOString();
}

function safeAvatarUrl(value) {
  const text = stringValue(value, 2_048);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function authModeOf(account) {
  const data = account?.auth_data && typeof account.auth_data === "object" ? account.auth_data : null;
  const mode = stringValue(account?.auth_mode, 32) || stringValue(data?.type, 32);
  if (mode === "api_key" || mode === "api-key") return "api-key";
  if (mode === "chat_g_p_t" || mode === "chatgpt" || mode === "chat_gpt") return "chatgpt";
  return "unknown";
}

function decodeJwtPayload(token) {
  const value = stringValue(token, 1_000_000);
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const parsed = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function claimsFromToken(token) {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  return {
    email: stringValue(payload?.email, 320),
    accountId: stringValue(auth?.chatgpt_account_id, 512),
    plan: stringValue(auth?.chatgpt_plan_type, 64),
    subscriptionExpiresAt: dateValue(auth?.chatgpt_subscription_active_until),
    picture: safeAvatarUrl(payload?.picture || payload?.avatar_url || auth?.picture || auth?.avatar_url),
  };
}

function accountAuthData(account) {
  const data = account?.auth_data && typeof account.auth_data === "object" ? account.auth_data : {};
  const mode = authModeOf(account);
  if (mode === "api-key") {
    const key = stringValue(data.key, 8_192) || stringValue(data.OPENAI_API_KEY, 8_192);
    return key ? { mode, key } : null;
  }
  if (mode !== "chatgpt") return null;
  const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : data;
  const accessToken = stringValue(tokens.access_token, 1_000_000);
  const idToken = stringValue(tokens.id_token, 1_000_000);
  const refreshToken = stringValue(tokens.refresh_token, 1_000_000);
  if (!accessToken) return null;
  return {
    mode,
    idToken,
    accessToken,
    refreshToken,
    accountId: stringValue(tokens.account_id, 512) || stringValue(data.account_id, 512),
  };
}

function accountIdentity(account) {
  const data = accountAuthData(account);
  if (!data || data.mode !== "chatgpt") return null;
  return data.accountId || claimsFromToken(data.idToken || data.accessToken).accountId || null;
}

function authIdentity(auth) {
  const tokens = auth?.tokens && typeof auth.tokens === "object" ? auth.tokens : null;
  if (!tokens) return null;
  return stringValue(tokens.account_id, 512) || claimsFromToken(tokens.id_token || tokens.access_token).accountId;
}

function authClaims(auth) {
  const tokens = auth?.tokens && typeof auth.tokens === "object" ? auth.tokens : null;
  if (!tokens) return { email: null, plan: null, subscriptionExpiresAt: null };
  return claimsFromToken(tokens.id_token || tokens.access_token);
}

function accountStatus(account, activeAccountId, now = Date.now()) {
  const expires = account.subscription_expires_at ? Date.parse(account.subscription_expires_at) : Number.NaN;
  if (Number.isFinite(expires) && expires <= now) return "expired";
  if (account.is_active || account.id === activeAccountId) return "active";
  if (account.authMode === "unknown") return "unavailable";
  return "ready";
}

function shortIdentifier(value) {
  const text = stringValue(value, 512);
  return text ? text.slice(0, 8) : null;
}

function projectAccount(account, activeAccountId, now = Date.now(), usageCache = null) {
  const id = stringValue(account?.id, 512);
  if (!id) return null;
  const data = accountAuthData(account);
  const claims = data?.mode === "chatgpt" ? claimsFromToken(data.idToken || data.accessToken) : {};
  const email = stringValue(account.email, 320) || claims.email || null;
  const plan = stringValue(account.plan_type, 64) || claims.plan || null;
  const subscriptionExpiresAt = dateValue(account.subscription_expires_at) || claims.subscriptionExpiresAt || null;
  const avatarUrl = safeAvatarUrl(
    account.avatar_url
      || account.avatarUrl
      || account.picture
      || claims.picture
      || usageCache?.stats?.avatarUrl,
  );
  const summary = {
    id,
    shortId: shortIdentifier(id),
    name: stringValue(account.name, 160) || email || "Codex account",
    email,
    plan,
    authMode: data?.mode || authModeOf(account),
    accountId: shortIdentifier(data?.accountId || claims.accountId),
    isActive: id === activeAccountId,
    createdAt: dateValue(account.created_at),
    lastUsedAt: dateValue(account.last_used_at),
    subscriptionExpiresAt,
    avatarUrl,
    usage: usageCache?.usage || null,
    stats: usageCache?.stats || null,
  };
  return { ...summary, status: accountStatus(summary, activeAccountId, now) };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function readAccountStore(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, valid: true, value: { version: 1, accounts: [], active_account_id: null } };
  }
  const value = readJson(filePath);
  if (!value || typeof value !== "object" || !Array.isArray(value.accounts)) {
    return { exists: true, valid: false, value: null };
  }
  return {
    exists: true,
    valid: true,
    value: {
      ...value,
      accounts: value.accounts.filter(account => account && typeof account === "object"),
    },
  };
}

function readAuthFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const value = readJson(filePath);
  return value && typeof value === "object" ? value : null;
}

function activeAccountIdFor(store, auth) {
  const identity = authIdentity(auth);
  if (identity) {
    const matching = store.accounts.find(account => accountIdentity(account) === identity);
    if (matching?.id) return matching.id;
  }
  const configured = stringValue(store.active_account_id, 512);
  return configured && store.accounts.some(account => account.id === configured) ? configured : null;
}

function syncActiveTokens(store, auth) {
  const tokens = auth?.tokens && typeof auth.tokens === "object" ? auth.tokens : null;
  const identity = authIdentity(auth);
  if (!tokens || !identity) return false;
  const account = store.accounts.find(candidate => accountIdentity(candidate) === identity);
  if (!account) return false;
  const data = account.auth_data && typeof account.auth_data === "object" ? account.auth_data : null;
  if (!data || authModeOf(account) !== "chatgpt") return false;
  const target = data.tokens && typeof data.tokens === "object" ? data.tokens : data;
  if (!stringValue(target.access_token, 1_000_000)) return false;
  const changed = (stringValue(tokens.id_token, 1_000_000) && target.id_token !== tokens.id_token)
    || target.access_token !== tokens.access_token
    || (stringValue(tokens.refresh_token, 1_000_000) && target.refresh_token !== tokens.refresh_token)
    || target.account_id !== identity;
  if (!changed) return false;
  if (stringValue(tokens.id_token, 1_000_000)) target.id_token = tokens.id_token;
  target.access_token = tokens.access_token;
  if (stringValue(tokens.refresh_token, 1_000_000)) target.refresh_token = tokens.refresh_token;
  target.account_id = identity;
  return true;
}

function authJsonForAccount(account) {
  const data = accountAuthData(account);
  if (!data) throw new Error("The selected account has no usable Codex credentials");
  if (data.mode === "api-key") return { OPENAI_API_KEY: data.key };
  return {
    tokens: {
      access_token: data.accessToken,
      ...(data.idToken ? { id_token: data.idToken } : {}),
      ...(data.refreshToken ? { refresh_token: data.refreshToken } : {}),
      ...(data.accountId ? { account_id: data.accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

function accountRecordFromAuthJson(value, requestedName = "") {
  if (!value || typeof value !== "object") throw new Error("The selected file is not a Codex auth.json file");
  const candidate = value.auth_data && typeof value.auth_data === "object"
    ? value
    : {
        auth_mode: value.tokens && typeof value.tokens === "object" ? "chat_g_p_t" : "api_key",
        auth_data: value,
      };
  const data = accountAuthData(candidate);
  if (!data) throw new Error("The selected auth.json does not contain usable Codex credentials");
  const now = new Date().toISOString();
  if (data.mode === "api-key") {
    return {
      id: crypto.randomUUID(),
      name: stringValue(requestedName, 160) || "API key account",
      email: null,
      plan_type: null,
      subscription_expires_at: null,
      auth_mode: "api_key",
      auth_data: { type: "api_key", key: data.key },
      created_at: now,
      last_used_at: null,
    };
  }
  const claims = claimsFromToken(data.idToken || data.accessToken);
  const email = claims.email;
  const accountId = data.accountId || claims.accountId;
  return {
    id: crypto.randomUUID(),
    name: stringValue(requestedName, 160) || email || `ChatGPT account${accountId ? ` (${shortIdentifier(accountId)})` : ""}`,
    email,
    plan_type: claims.plan,
    subscription_expires_at: claims.subscriptionExpiresAt,
    ...(claims.picture ? { avatar_url: claims.picture } : {}),
    auth_mode: "chat_g_p_t",
    auth_data: {
      type: "chat_g_p_t",
      ...(data.idToken ? { id_token: data.idToken } : {}),
      access_token: data.accessToken,
      ...(data.refreshToken ? { refresh_token: data.refreshToken } : {}),
      ...(accountId ? { account_id: accountId } : {}),
    },
    created_at: now,
    last_used_at: null,
  };
}

function accountRecordFromTokenSet(tokens, requestedName = "") {
  return accountRecordFromAuthJson({ tokens }, requestedName);
}

function oauthBase64Url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createOAuthPkce() {
  const verifier = oauthBase64Url(crypto.randomBytes(64));
  const challenge = oauthBase64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildOAuthAuthorizeUrl(redirectUri, pkce, state) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  });
  return `${OPENAI_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function createOAuthServer(handler) {
  const listen = port => new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const onError = error => {
      server.removeListener("listening", onListening);
      reject({ error, server });
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  try {
    return await listen(OPENAI_OAUTH_DEFAULT_PORT);
  } catch (result) {
    result.server.close();
    if (result.error?.code !== "EADDRINUSE") throw result.error;
    return listen(0);
  }
}

async function exchangeOAuthCode({ redirectUri, pkce, code }) {
  if (typeof fetch !== "function") throw new Error("OAuth login is unavailable in this runtime");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHATGPT_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: OPENAI_OAUTH_CLIENT_ID,
        code_verifier: pkce.verifier,
      }),
      redirect: "error",
      signal: controller.signal,
    });
    const body = await response.text();
    let payload = null;
    try { payload = JSON.parse(body); } catch {}
    if (!response.ok) throw new Error(`OAuth token exchange failed (HTTP ${response.status})`);
    const idToken = stringValue(payload?.id_token, 1_000_000);
    const accessToken = stringValue(payload?.access_token, 1_000_000);
    const refreshToken = stringValue(payload?.refresh_token, 1_000_000);
    if (!idToken || !accessToken || !refreshToken) throw new Error("OAuth token response was incomplete");
    return { id_token: idToken, access_token: accessToken, refresh_token: refreshToken };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("OAuth token exchange timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function saveAccountStore(filePath, store) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

function loadActivity(filePath) {
  const value = readJson(filePath);
  if (!value || typeof value !== "object" || !Array.isArray(value.events)) return [];
  return value.events.filter(event => event
    && typeof event === "object"
    && stringValue(event.accountId, 512)
    && dateValue(event.at)
    && (event.kind === "switch" || event.kind === "import"));
}

function saveActivity(filePath, events) {
  writePrivateFileAtomic(filePath, `${JSON.stringify({ version: 1, events: events.slice(-MAX_ACTIVITY_EVENTS) }, null, 2)}\n`);
}

function recordActivity(filePath, accountId, kind) {
  const events = loadActivity(filePath);
  events.push({ at: new Date().toISOString(), accountId, kind });
  saveActivity(filePath, events);
}

function activitySummary(filePath, accounts, now = Date.now()) {
  const events = loadActivity(filePath);
  const accountNames = new Map(accounts.map(account => [account.id, account.name]));
  const today = new Date(now).toISOString().slice(0, 10);
  const dayCounts = new Map();
  const recent = [];
  for (const event of events) {
    const at = dateValue(event.at);
    if (!at) continue;
    const day = at.slice(0, 10);
    if (event.kind === "switch") dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    recent.push({
      at,
      accountId: event.accountId,
      accountName: accountNames.get(event.accountId) || "Removed account",
      kind: event.kind,
    });
  }
  const daily = [];
  for (let offset = ACTIVITY_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    daily.push({ date: key, count: dayCounts.get(key) || 0 });
  }
  return {
    totalSwitches: events.filter(event => event.kind === "switch").length,
    switchesToday: dayCounts.get(today) || 0,
    activeDays: daily.filter(day => day.count > 0).length,
    lastSwitchAt: [...recent].reverse().find(event => event.kind === "switch")?.at || null,
    daily,
    recent: recent.slice(-12).reverse(),
  };
}

function finiteNumber(value, { minimum = Number.NEGATIVE_INFINITY, maximum = Number.POSITIVE_INFINITY } = {}) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum ? numeric : null;
}

function timestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return dateValue(value);
}

function usageWindow(value) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = finiteNumber(value.used_percent ?? value.usedPercent, { minimum: 0, maximum: 100 });
  const windowSeconds = finiteNumber(value.limit_window_seconds ?? value.windowSeconds, { minimum: 1, maximum: 31_536_000 });
  const resetAt = timestampValue(value.reset_at ?? value.resetAt);
  return {
    usedPercent,
    windowMinutes: windowSeconds === null ? null : Math.max(1, Math.ceil(windowSeconds / 60)),
    resetsAt: resetAt,
    windowSeconds,
  };
}

function normalizeUsageWindows(rateLimit) {
  const source = rateLimit && typeof rateLimit === "object" ? rateLimit : {};
  let primary = usageWindow(source.primary_window || source.primaryWindow || source.primary);
  let secondary = usageWindow(source.secondary_window || source.secondaryWindow || source.secondary);
  const sessionSeconds = 5 * 60 * 60;
  const weeklySeconds = 7 * 24 * 60 * 60;
  if (primary?.windowSeconds === weeklySeconds && !secondary) {
    secondary = primary;
    primary = null;
  } else if (!primary && secondary?.windowSeconds === sessionSeconds) {
    primary = secondary;
    secondary = null;
  } else if (primary?.windowSeconds === weeklySeconds && secondary?.windowSeconds === sessionSeconds) {
    [primary, secondary] = [secondary, primary];
  }
  return { primary, secondary };
}

function emptyUsage(error = null, fetchedAt = null) {
  return {
    available: error === null,
    fetchedAt,
    primaryUsedPercent: null,
    primaryWindowMinutes: null,
    primaryResetsAt: null,
    secondaryUsedPercent: null,
    secondaryWindowMinutes: null,
    secondaryResetsAt: null,
    hasCredits: null,
    unlimitedCredits: null,
    creditsBalance: null,
    error,
  };
}

function mapUsagePayload(payload, fetchedAt) {
  const windows = normalizeUsageWindows(payload?.rate_limit || payload?.rateLimit || payload?.rate_limit_status);
  const credits = payload?.credits && typeof payload.credits === "object" ? payload.credits : null;
  return {
    ...emptyUsage(null, fetchedAt),
    primaryUsedPercent: windows.primary?.usedPercent ?? null,
    primaryWindowMinutes: windows.primary?.windowMinutes ?? null,
    primaryResetsAt: windows.primary?.resetsAt ?? null,
    secondaryUsedPercent: windows.secondary?.usedPercent ?? null,
    secondaryWindowMinutes: windows.secondary?.windowMinutes ?? null,
    secondaryResetsAt: windows.secondary?.resetsAt ?? null,
    hasCredits: typeof credits?.has_credits === "boolean" ? credits.has_credits : null,
    unlimitedCredits: typeof credits?.unlimited === "boolean"
      ? credits.unlimited
      : typeof credits?.unlimited_credits === "boolean" ? credits.unlimited_credits : null,
    creditsBalance: stringValue(credits?.balance ?? credits?.credits_balance, 128),
  };
}

function emptyStats(error = null, fetchedAt = null) {
  return {
    available: error === null,
    fetchedAt,
    generatedAt: null,
    statsAsOf: null,
    lifetimeTokens: null,
    peakDailyTokens: null,
    longestTaskSeconds: null,
    currentStreakDays: null,
    longestStreakDays: null,
    fastModePercent: null,
    reasoningEffort: null,
    reasoningEffortPercent: null,
    skillsExplored: null,
    totalSkillsUsed: null,
    totalThreads: null,
    resetCreditsAvailable: null,
    resetCreditsNextExpiresAt: null,
    avatarUrl: null,
    daily: [],
    error,
  };
}

function mapResetCreditsPayload(payload, now = Date.now()) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const credits = Array.isArray(source?.credits) ? source.credits : [];
  const availableCredits = credits.filter(credit => stringValue(credit?.status, 64) === "available");
  const availableCount = finiteNumber(source?.available_count ?? source?.availableCount, {
    minimum: 0,
    maximum: 10_000,
  }) ?? availableCredits.length;
  const computedNextExpiresAt = availableCredits
    .map(credit => dateValue(credit?.expires_at ?? credit?.expiresAt))
    .filter(value => value && Date.parse(value) > now)
    .sort()[0] || null;
  const reportedNextExpiresAt = dateValue(source?.next_expires_at ?? source?.nextExpiresAt);
  const nextExpiresAt = [computedNextExpiresAt, reportedNextExpiresAt]
    .filter(value => value && Date.parse(value) > now)
    .sort()[0] || null;
  return { availableCount, nextExpiresAt };
}

function mapStatsPayload(payload, fetchedAt) {
  const stats = payload?.stats && typeof payload.stats === "object" ? payload.stats : {};
  const metadata = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const profile = payload?.profile && typeof payload.profile === "object" ? payload.profile : {};
  const daily = Array.isArray(stats.daily_usage_buckets)
    ? stats.daily_usage_buckets.map(bucket => ({
        date: stringValue(bucket?.start_date ?? bucket?.date, 64),
        tokens: finiteNumber(bucket?.tokens, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      })).filter(bucket => bucket.date && bucket.tokens !== null).slice(-366)
    : [];
  return {
    ...emptyStats(null, fetchedAt),
    generatedAt: dateValue(metadata.generated_at),
    statsAsOf: dateValue(metadata.stats_as_of),
    lifetimeTokens: finiteNumber(stats.lifetime_tokens, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    peakDailyTokens: finiteNumber(stats.peak_daily_tokens, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    longestTaskSeconds: finiteNumber(stats.longest_running_turn_sec, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    currentStreakDays: finiteNumber(stats.current_streak_days, { minimum: 0, maximum: 10_000 }),
    longestStreakDays: finiteNumber(stats.longest_streak_days, { minimum: 0, maximum: 10_000 }),
    fastModePercent: finiteNumber(stats.fast_mode_usage_percentage, { minimum: 0, maximum: 100 }),
    reasoningEffort: stringValue(stats.most_used_reasoning_effort, 64),
    reasoningEffortPercent: finiteNumber(stats.most_used_reasoning_effort_percentage, { minimum: 0, maximum: 100 }),
    skillsExplored: finiteNumber(stats.unique_skills_used, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    totalSkillsUsed: finiteNumber(stats.total_skills_used, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    totalThreads: finiteNumber(stats.total_threads, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    avatarUrl: safeAvatarUrl(
      profile.avatar_url
        || profile.avatarUrl
        || profile.picture
        || payload?.avatar_url
        || payload?.avatarUrl
        || payload?.picture,
    ),
    daily,
    error: stringValue(metadata.stats_error, 512),
    available: !stringValue(metadata.stats_error, 512),
  };
}

function safeUsageCache(value) {
  if (!value || typeof value !== "object") return null;
  const usage = value.usage && typeof value.usage === "object" ? value.usage : null;
  const stats = value.stats && typeof value.stats === "object" ? value.stats : null;
  return {
    usage: usage ? {
      ...emptyUsage(stringValue(usage.error, 512), dateValue(usage.fetchedAt)),
      available: usage.available === true,
      primaryUsedPercent: finiteNumber(usage.primaryUsedPercent, { minimum: 0, maximum: 100 }),
      primaryWindowMinutes: finiteNumber(usage.primaryWindowMinutes, { minimum: 1, maximum: 31_536_000 }),
      primaryResetsAt: dateValue(usage.primaryResetsAt),
      secondaryUsedPercent: finiteNumber(usage.secondaryUsedPercent, { minimum: 0, maximum: 100 }),
      secondaryWindowMinutes: finiteNumber(usage.secondaryWindowMinutes, { minimum: 1, maximum: 31_536_000 }),
      secondaryResetsAt: dateValue(usage.secondaryResetsAt),
      hasCredits: typeof usage.hasCredits === "boolean" ? usage.hasCredits : null,
      unlimitedCredits: typeof usage.unlimitedCredits === "boolean" ? usage.unlimitedCredits : null,
      creditsBalance: stringValue(usage.creditsBalance, 128),
    } : null,
    stats: stats ? {
      ...emptyStats(stringValue(stats.error, 512), dateValue(stats.fetchedAt)),
      available: stats.available === true,
      generatedAt: dateValue(stats.generatedAt),
      statsAsOf: dateValue(stats.statsAsOf),
      lifetimeTokens: finiteNumber(stats.lifetimeTokens, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      peakDailyTokens: finiteNumber(stats.peakDailyTokens, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      longestTaskSeconds: finiteNumber(stats.longestTaskSeconds, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      currentStreakDays: finiteNumber(stats.currentStreakDays, { minimum: 0, maximum: 10_000 }),
      longestStreakDays: finiteNumber(stats.longestStreakDays, { minimum: 0, maximum: 10_000 }),
      fastModePercent: finiteNumber(stats.fastModePercent, { minimum: 0, maximum: 100 }),
      reasoningEffort: stringValue(stats.reasoningEffort, 64),
      reasoningEffortPercent: finiteNumber(stats.reasoningEffortPercent, { minimum: 0, maximum: 100 }),
      skillsExplored: finiteNumber(stats.skillsExplored, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      totalSkillsUsed: finiteNumber(stats.totalSkillsUsed, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      totalThreads: finiteNumber(stats.totalThreads, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      resetCreditsAvailable: finiteNumber(stats.resetCreditsAvailable, { minimum: 0, maximum: 10_000 }),
      resetCreditsNextExpiresAt: dateValue(stats.resetCreditsNextExpiresAt),
      avatarUrl: safeAvatarUrl(stats.avatarUrl),
      daily: Array.isArray(stats.daily) ? stats.daily.map(day => ({
        date: stringValue(day?.date, 64),
        tokens: finiteNumber(day?.tokens, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      })).filter(day => day.date && day.tokens !== null).slice(-366) : [],
    } : null,
  };
}

function loadUsageCache(filePath) {
  const value = readJson(filePath);
  if (!value || typeof value !== "object" || !value.accounts || typeof value.accounts !== "object") return {};
  return Object.fromEntries(Object.entries(value.accounts)
    .map(([accountId, record]) => [accountId, safeUsageCache(record)])
    .filter(([accountId, record]) => stringValue(accountId, 512) && record));
}

function saveUsageCache(filePath, records) {
  const safeRecords = Object.fromEntries(Object.entries(records).slice(-100));
  writePrivateFileAtomic(filePath, `${JSON.stringify({ version: 1, accounts: safeRecords }, null, 2)}\n`);
}

function requestHeaders(accessToken, accountId) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Authorization: `Bearer ${accessToken}`,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "User-Agent": CHATGPT_USER_AGENT,
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
  };
}

async function requestJson(url, accessToken, accountId) {
  if (typeof fetch !== "function") throw new Error("ChatGPT usage refresh is unavailable in this runtime");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHATGPT_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: requestHeaders(accessToken, accountId),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ChatGPT usage request returned HTTP ${response.status}`);
    return response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("ChatGPT usage request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAccountUsage(account) {
  const fetchedAt = new Date().toISOString();
  const data = accountAuthData(account);
  if (!data || data.mode !== "chatgpt") {
    return {
      usage: emptyUsage("Usage is available for ChatGPT OAuth accounts only", fetchedAt),
      stats: emptyStats("Usage stats are available for ChatGPT OAuth accounts only", fetchedAt),
    };
  }
  const accountId = data.accountId || claimsFromToken(data.idToken || data.accessToken).accountId;
  const results = await Promise.allSettled([
    requestJson(CHATGPT_USAGE_URL, data.accessToken, accountId),
    requestJson(CHATGPT_PROFILE_USAGE_URL, data.accessToken, accountId),
  ]);
  const usageResult = results[0];
  const statsResult = results[1];
  const usage = usageResult.status === "fulfilled"
    ? mapUsagePayload(usageResult.value, fetchedAt)
    : emptyUsage(safeErrorMessage(usageResult.reason), fetchedAt);
  let stats = statsResult.status === "fulfilled"
    ? mapStatsPayload(statsResult.value, fetchedAt)
    : emptyStats(safeErrorMessage(statsResult.reason), fetchedAt);
  if (stats.available) {
    try {
      const credits = await requestJson(CHATGPT_RESET_CREDITS_URL, data.accessToken, accountId);
      const resetCredits = mapResetCreditsPayload(credits);
      stats = {
        ...stats,
        resetCreditsAvailable: resetCredits.availableCount,
        resetCreditsNextExpiresAt: resetCredits.nextExpiresAt,
      };
    } catch {
      stats = {
        ...stats,
        resetCreditsAvailable: null,
        resetCreditsNextExpiresAt: null,
      };
    }
  }
  return { usage, stats };
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP \d+/.test(message) || /timed out|unavailable/i.test(message)
    ? message.slice(0, 512)
    : "ChatGPT usage refresh failed";
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), items.length || 1) }, worker));
  return results;
}

function defaultOfficialState(platform) {
  if (platform !== "win32") {
    return {
      supported: false,
      installed: false,
      running: false,
      processCount: 0,
      version: null,
      canSwitch: false,
      message: "Official Codex account switching is currently available on Windows.",
    };
  }
  return {
    supported: true,
    installed: false,
    running: false,
    processCount: 0,
    version: null,
    canSwitch: false,
    message: "Official Microsoft Store Codex was not detected.",
  };
}

async function terminateOfficialProcesses(identity, processes, {
  listProcesses = listOfficialCodexProcesses,
  platform = process.platform,
  timeoutMs = PROCESS_WAIT_TIMEOUT_MS,
  intervalMs = PROCESS_WAIT_INTERVAL_MS,
  execFileAsync: runTaskkill = execFileAsync,
} = {}) {
  const pids = [...new Set((Array.isArray(processes) ? processes : [])
    .map(process => process?.ProcessId ?? process?.pid)
    .filter(pid => Number.isInteger(pid) || /^\d+$/.test(String(pid)))
    .map(pid => String(pid)))];
  if (pids.length === 0) return;
  if (platform !== "win32") throw new Error("Official Codex restart is currently available on Windows only");
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  for (const pid of pids) {
    await runTaskkill(taskkill, ["/PID", pid, "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }).catch(error => {
      const detail = [error?.message, error?.stdout, error?.stderr]
        .filter(value => typeof value === "string")
        .join(" ");
      const processNotFound = error?.code === "ERRORLEVEL_128"
        || error?.status === 128
        || /process(?: with the specified pid)?[^.]*not found/i.test(detail)
        || /specified pid was not found/i.test(detail);
      if (!processNotFound) throw error;
      return listProcesses(identity).then(remaining => {
        const stillRunning = Array.isArray(remaining) && remaining.some(candidate => String(
          candidate?.ProcessId ?? candidate?.pid,
        ) === pid);
        if (stillRunning) throw error;
      });
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = await listProcesses(identity);
    if (!Array.isArray(remaining) || remaining.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error("Official Codex did not close before account switching timed out");
}

async function officialState({
  platform,
  resolveIdentity = resolveOfficialCodexIdentity,
  listProcesses = listOfficialCodexProcesses,
} = {}) {
  const base = defaultOfficialState(platform);
  if (!base.supported) return base;
  try {
    const identity = await resolveIdentity();
    const processes = await listProcesses(identity);
    return {
      ...base,
      installed: true,
      running: processes.length > 0,
      processCount: processes.length,
      version: stringValue(identity.Version, 128),
      canSwitch: true,
      message: processes.length > 0
        ? "Official Codex is running and will restart after a switch."
        : "Official Codex is ready; the selected account will apply on its next launch.",
    };
  } catch {
    return base;
  }
}

function currentAccountProjection(auth) {
  if (!auth || typeof auth !== "object") return { present: false, managed: false, email: null, plan: null, authMode: null };
  if (auth.tokens && typeof auth.tokens === "object") {
    const data = accountAuthData({ auth_mode: "chat_g_p_t", auth_data: { tokens: auth.tokens } });
    if (!data) return { present: false, managed: false, email: null, plan: null, authMode: null };
    const claims = authClaims(auth);
    return {
      present: true,
      managed: false,
      email: claims.email,
      plan: claims.plan,
      authMode: "chatgpt",
    };
  }
  if (stringValue(auth.OPENAI_API_KEY, 8_192)) {
    return { present: true, managed: false, email: null, plan: null, authMode: "api-key" };
  }
  return { present: false, managed: false, email: null, plan: null, authMode: null };
}

function createAccountSwitcher({
  platform = process.platform,
  homeDir = os.homedir(),
  codexHome = path.join(homeDir, ".codex"),
  accountStorePath = path.join(homeDir, ".codex-switcher", "accounts.json"),
  activityPath = path.join(homeDir, ".codex-chatgpt-web", "account-activity.json"),
  usageCachePath = path.join(homeDir, ".codex-chatgpt-web", "account-usage.json"),
  logger = { info() {}, warn() {}, error() {} },
  resolveIdentity = resolveOfficialCodexIdentity,
  listProcesses = listOfficialCodexProcesses,
  terminateProcesses = terminateOfficialProcesses,
  launchApp = launchOfficialCodexApplication,
  openExternal = async () => {},
  beforeOfficialRestart = async () => null,
  afterOfficialRestart = async ({ identity }) => launchApp(identity),
  abortOfficialRestart = async () => {},
} = {}) {
  const resolvedStorePath = path.resolve(accountStorePath);
  const resolvedActivityPath = path.resolve(activityPath);
  const resolvedUsageCachePath = path.resolve(usageCachePath);
  const authPath = path.join(path.resolve(codexHome), "auth.json");
  let operation = Promise.resolve();
  let usageRefreshPromise = null;
  let pendingOAuth = null;

  async function snapshot({ refreshUsage = false } = {}) {
    if (refreshUsage) await refreshUsageNow();
    const storeState = readAccountStore(resolvedStorePath);
    const store = storeState.value || { version: 1, accounts: [], active_account_id: null };
    const auth = readAuthFile(authPath);
    const activeAccountId = activeAccountIdFor(store, auth);
    const usageCache = loadUsageCache(resolvedUsageCachePath);
    const accounts = store.accounts
      .map(account => projectAccount(account, activeAccountId, Date.now(), usageCache[account.id]))
      .filter(Boolean);
    const currentSession = currentAccountProjection(auth);
    currentSession.managed = accounts.some(account => account.isActive);
    const officialApp = await officialState({ platform, resolveIdentity, listProcesses });
    return {
      supported: platform === "win32",
      configured: storeState.valid && accounts.length > 0,
      source: storeState.exists ? "codex-switcher" : "official-codex",
      storePath: resolvedStorePath,
      activeAccountId,
      accounts,
      currentSession,
      officialApp,
      activity: activitySummary(resolvedActivityPath, accounts),
    };
  }

  async function refreshUsageNow() {
    if (platform !== "win32") return;
    if (usageRefreshPromise) return usageRefreshPromise;
    usageRefreshPromise = (async () => {
      const storeState = readAccountStore(resolvedStorePath);
      if (!storeState.valid || storeState.value.accounts.length === 0) return;
      const store = storeState.value;
      const auth = readAuthFile(authPath);
      if (syncActiveTokens(store, auth)) saveAccountStore(resolvedStorePath, store);
      const records = loadUsageCache(resolvedUsageCachePath);
      const refreshed = await mapWithConcurrency(store.accounts, 3, async account => {
        const record = await fetchAccountUsage(account).catch(error => ({
          usage: emptyUsage(safeErrorMessage(error), new Date().toISOString()),
          stats: emptyStats(safeErrorMessage(error), new Date().toISOString()),
        }));
        records[account.id] = record;
        return record;
      });
      if (refreshed.length > 0) saveUsageCache(resolvedUsageCachePath, records);
      logger.info("accounts.usage_refreshed", { accountCount: refreshed.length });
    })().finally(() => {
      usageRefreshPromise = null;
    });
    return usageRefreshPromise;
  }

  function addAccountToStore(store, account) {
    const identity = accountIdentity(account);
    const email = stringValue(account.email, 320);
    const duplicate = store.accounts.find(candidate => (
      identity && accountIdentity(candidate) === identity
    ) || (
      !identity && email && stringValue(candidate.email, 320) === email
    ));
    if (duplicate) throw new Error("This Codex account is already added");
    store.accounts.push(account);
    if (!stringValue(store.active_account_id, 512)) {
      store.active_account_id = store.accounts[0]?.id || account.id;
    }
    return account;
  }

  async function addAccountFromFile(filePath, requestedName = "") {
    return enqueue(async () => {
      if (platform !== "win32") throw new Error("Official Codex account switching is currently available on Windows");
      const selectedPath = stringValue(filePath, 4_096);
      if (!selectedPath) throw new Error("An auth.json file must be selected");
      let stat;
      try {
        stat = fs.statSync(path.resolve(selectedPath));
      } catch {
        throw new Error("The selected auth.json file could not be read");
      }
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
        throw new Error("The selected auth.json file is invalid or too large");
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.resolve(selectedPath), "utf8").replace(/^\uFEFF/, ""));
      } catch {
        throw new Error("The selected file is not valid JSON");
      }
      const account = accountRecordFromAuthJson(parsed, requestedName);
      const storeState = readAccountStore(resolvedStorePath);
      if (!storeState.valid) throw new Error("The Codex Switcher account store could not be read");
      addAccountToStore(storeState.value, account);
      saveAccountStore(resolvedStorePath, storeState.value);
      recordActivity(resolvedActivityPath, account.id, "import");
      logger.info("accounts.account_added", { accountId: account.id.slice(0, 8), source: "auth-file" });
      return snapshot();
    });
  }

  async function startOAuthLogin(requestedName = "") {
    if (platform !== "win32") throw new Error("Official Codex account switching is currently available on Windows");
    await cancelOAuthLogin();
    const pkce = createOAuthPkce();
    const state = oauthBase64Url(crypto.randomBytes(32));
    let pending = null;
    const server = await createOAuthServer(async (request, response) => {
      if (!pending || pending.cancelled || pending.settled) {
        response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("This login is no longer active.");
        return;
      }
      let parsed;
      try {
        parsed = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      } catch {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Bad request.");
        return;
      }
      if (request.method !== "GET" || parsed.pathname !== "/auth/callback") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found.");
        return;
      }
      const error = stringValue(parsed.searchParams.get("error"), 256);
      if (error) {
        pending.settled = true;
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Codex account login was not completed.</h1><p>You can close this window.</p>");
        pending.server.close();
        pending.reject(new Error("OAuth login was not completed"));
        return;
      }
      if (parsed.searchParams.get("state") !== state) {
        pending.settled = true;
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("State verification failed.");
        pending.server.close();
        pending.reject(new Error("OAuth state verification failed"));
        return;
      }
      const code = stringValue(parsed.searchParams.get("code"), 4_096);
      if (!code) {
        pending.settled = true;
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Authorization code was missing.");
        pending.server.close();
        pending.reject(new Error("OAuth authorization code was missing"));
        return;
      }
      pending.settled = true;
      try {
        const tokens = await exchangeOAuthCode({
          redirectUri: pending.redirectUri,
          pkce,
          code,
        });
        const account = accountRecordFromTokenSet(tokens, requestedName);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Codex account added.</h1><p>You can close this window and return to Codex Web GPT.</p>");
        pending.resolve(account);
      } catch (callbackError) {
        response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Codex account login failed.</h1><p>You can close this window and return to Codex Web GPT.</p>");
        pending.reject(callbackError);
      } finally {
        pending.server.close();
      }
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : null;
    if (!port) {
      server.close();
      throw new Error("The local OAuth callback server did not expose a port");
    }
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const authUrl = buildOAuthAuthorizeUrl(redirectUri, pkce, state);
    const result = new Promise((resolve, reject) => {
      pending = {
        accountName: stringValue(requestedName, 160) || "",
        cancelled: false,
        settled: false,
        server,
        redirectUri,
        resolve,
        reject,
      };
    });
    result.catch(() => {});
    pending.result = result;
    pending.timer = null;
    pendingOAuth = pending;
    pendingOAuth.timer = setTimeout(() => {
      if (pendingOAuth?.settled || pendingOAuth?.cancelled) return;
      pendingOAuth.settled = true;
      pendingOAuth.server.close();
      pendingOAuth.reject(new Error("OAuth login timed out"));
    }, OPENAI_OAUTH_TIMEOUT_MS);
    pendingOAuth.timer.unref?.();
    try {
      await openExternal(authUrl);
    } catch (error) {
      await cancelOAuthLogin();
      throw error;
    }
    return { authUrl, callbackPort: port };
  }

  async function completeOAuthLogin() {
    const pending = pendingOAuth;
    if (!pending) throw new Error("No pending Codex account login");
    try {
      const account = await pending.result;
      pendingOAuth = null;
      return enqueue(async () => {
        const storeState = readAccountStore(resolvedStorePath);
        if (!storeState.valid) throw new Error("The Codex Switcher account store could not be read");
        addAccountToStore(storeState.value, account);
        saveAccountStore(resolvedStorePath, storeState.value);
        recordActivity(resolvedActivityPath, account.id, "import");
        logger.info("accounts.account_added", { accountId: account.id.slice(0, 8), source: "oauth" });
        return snapshot();
      });
    } finally {
      clearTimeout(pending.timer);
      pending.server.close();
      if (pendingOAuth === pending) pendingOAuth = null;
    }
  }

  async function cancelOAuthLogin() {
    const pending = pendingOAuth;
    if (!pending) return;
    pendingOAuth = null;
    pending.cancelled = true;
    clearTimeout(pending.timer);
    pending.server.close();
    pending.reject(new Error("OAuth login cancelled"));
  }

  async function addCurrentAccount() {
    return enqueue(async () => {
      if (platform !== "win32") throw new Error("Official Codex account switching is currently available on Windows");
      const auth = readAuthFile(authPath);
      const current = currentAccountProjection(auth);
      if (!current.present) throw new Error("No official Codex account is signed in yet");
      const storeState = readAccountStore(resolvedStorePath);
      if (!storeState.valid) throw new Error("The Codex Switcher account store could not be read");
      const store = storeState.value;
      const identity = authIdentity(auth);
      let account = store.accounts.find(candidate => identity && accountIdentity(candidate) === identity);
      if (!account && current.email) account = store.accounts.find(candidate => candidate.email === current.email);
      if (!account) {
        const claims = authClaims(auth);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const tokens = auth.tokens;
        account = tokens ? {
          id,
          name: claims.email || "Current Codex account",
          email: claims.email,
          plan_type: claims.plan,
          subscription_expires_at: claims.subscriptionExpiresAt,
          auth_mode: "chat_g_p_t",
          auth_data: {
            type: "chat_g_p_t",
            id_token: tokens.id_token,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            account_id: identity,
          },
          created_at: now,
          last_used_at: now,
        } : {
          id,
          name: "Current API key account",
          email: null,
          plan_type: null,
          subscription_expires_at: null,
          auth_mode: "api_key",
          auth_data: { type: "api_key", key: auth.OPENAI_API_KEY },
          created_at: now,
          last_used_at: now,
        };
        store.accounts.push(account);
      }
      store.active_account_id = account.id;
      account.last_used_at = new Date().toISOString();
      saveAccountStore(resolvedStorePath, store);
      recordActivity(resolvedActivityPath, account.id, "import");
      logger.info("accounts.current_account_added", { accountId: account.id.slice(0, 8) });
      return snapshot();
    });
  }

  async function switchAccount(accountId) {
    return enqueue(async () => {
      const requestedId = stringValue(accountId, 512);
      if (!requestedId) throw new Error("Account id is invalid");
      if (platform !== "win32") throw new Error("Official Codex account switching is currently available on Windows");
      const storeState = readAccountStore(resolvedStorePath);
      if (!storeState.valid || storeState.value.accounts.length === 0) {
        throw new Error("No Codex Switcher accounts are configured");
      }
      const store = storeState.value;
      const target = store.accounts.find(account => account.id === requestedId);
      if (!target) throw new Error("Selected Codex account was not found");
      const currentAuth = readAuthFile(authPath);
      if (activeAccountIdFor(store, currentAuth) === requestedId) return snapshot();
      const targetAuth = authJsonForAccount(target);
      const identity = await resolveIdentity();
      const processes = await listProcesses(identity);
      const wasRunning = processes.length > 0;
      let restartContext = null;
      try {
        if (wasRunning) restartContext = await beforeOfficialRestart({ identity, processes });
        if (wasRunning) await terminateProcesses(identity, processes, { listProcesses, platform });

        const currentAuth = readAuthFile(authPath);
        if (syncActiveTokens(store, currentAuth)) saveAccountStore(resolvedStorePath, store);
        writePrivateFileAtomic(authPath, `${JSON.stringify(targetAuth, null, 2)}\n`);
        store.active_account_id = requestedId;
        target.last_used_at = new Date().toISOString();
        saveAccountStore(resolvedStorePath, store);
        recordActivity(resolvedActivityPath, requestedId, "switch");

        if (wasRunning) await afterOfficialRestart({ identity, restartContext });
        logger.info("accounts.account_switched", {
          accountId: requestedId.slice(0, 8),
          restartedOfficialApp: wasRunning,
        });
        return snapshot();
      } catch (error) {
        if (restartContext) await abortOfficialRestart({ identity, restartContext }).catch(() => {});
        throw error;
      }
    });
  }

  async function removeAccount(accountId) {
    return enqueue(async () => {
      const requestedId = stringValue(accountId, 512);
      if (!requestedId) throw new Error("Account id is invalid");
      const storeState = readAccountStore(resolvedStorePath);
      if (!storeState.valid) throw new Error("The Codex Switcher account store could not be read");
      const store = storeState.value;
      const currentAuth = readAuthFile(authPath);
      if (activeAccountIdFor(store, currentAuth) === requestedId) {
        throw new Error("Switch to another Codex account before removing the active account");
      }
      const index = store.accounts.findIndex(account => account.id === requestedId);
      if (index < 0) throw new Error("Selected Codex account was not found");
      store.accounts.splice(index, 1);
      saveAccountStore(resolvedStorePath, store);
      const usageRecords = loadUsageCache(resolvedUsageCachePath);
      if (Object.prototype.hasOwnProperty.call(usageRecords, requestedId)) {
        delete usageRecords[requestedId];
        saveUsageCache(resolvedUsageCachePath, usageRecords);
      }
      logger.info("accounts.account_removed", { accountId: requestedId.slice(0, 8) });
      return snapshot();
    });
  }

  function enqueue(work) {
    operation = operation.catch(() => {}).then(work);
    return operation;
  }

  return {
    snapshot,
    addAccountFromFile,
    addCurrentAccount,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    switchAccount,
    removeAccount,
    currentOperation() { return operation; },
    refreshUsage: refreshUsageNow,
    paths: { accountStore: resolvedStorePath, auth: authPath, activity: resolvedActivityPath, usage: resolvedUsageCachePath },
  };
}

module.exports = {
  ACTIVITY_DAYS,
  MAX_ACTIVITY_EVENTS,
  PROCESS_WAIT_INTERVAL_MS,
  PROCESS_WAIT_TIMEOUT_MS,
  accountAuthData,
  activitySummary,
  accountRecordFromAuthJson,
  createAccountSwitcher,
  decodeJwtPayload,
  mapResetCreditsPayload,
  mapStatsPayload,
  mapUsagePayload,
  safeUsageCache,
  projectAccount,
  terminateOfficialProcesses,
};
