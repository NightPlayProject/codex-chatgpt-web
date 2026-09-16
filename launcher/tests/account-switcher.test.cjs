const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createAccountSwitcher,
  mapResetCreditsPayload,
  mapStatsPayload,
  mapUsagePayload,
  projectAccount,
  safeUsageCache,
  terminateOfficialProcesses,
} = require("../electron/account-switcher.cjs");

const identity = Object.freeze({
  Version: "26.908.9136.0",
  Executable: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
  AppId: "OpenAI.Codex_2p2nqsd0c76g0!ChatGPT",
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fakeJwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

function account(id, email, tokenSuffix) {
  return {
    id,
    name: email.split("@")[0],
    email,
    plan_type: "plus",
    subscription_expires_at: "2099-01-01T00:00:00.000Z",
    auth_mode: "chat_g_p_t",
    auth_data: {
      type: "chat_g_p_t",
      id_token: `id-${tokenSuffix}`,
      access_token: `access-${tokenSuffix}`,
      refresh_token: `refresh-${tokenSuffix}`,
      account_id: `workspace-${tokenSuffix}`,
    },
    created_at: "2026-09-01T00:00:00.000Z",
    last_used_at: "2026-09-15T00:00:00.000Z",
  };
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

test("account projections expose safe metadata without credentials", () => {
  const summary = projectAccount(account("account-a", "alice@example.com", "a"), "account-a");
  assert.equal(summary.name, "alice");
  assert.equal(summary.email, "alice@example.com");
  assert.equal(summary.authMode, "chatgpt");
  assert.equal(summary.accountId, "workspac");
  assert.equal(summary.status, "active");
  assert.doesNotMatch(JSON.stringify(summary), /id-a|access-a|refresh-a/);
});

test("usage refresh maps native rate windows and token activity without retaining credentials", () => {
  const fetchedAt = "2026-09-16T12:00:00.000Z";
  const usage = mapUsagePayload({
    rate_limit: {
      primary_window: {
        used_percent: 7,
        limit_window_seconds: 18_000,
        reset_at: "2026-09-16T17:00:00.000Z",
      },
      secondary_window: {
        used_percent: 21,
        limit_window_seconds: 604_800,
        reset_at: "2026-09-23T12:00:00.000Z",
      },
    },
    credits: { has_credits: true, unlimited: false, balance: "2" },
  }, fetchedAt);
  const stats = mapStatsPayload({
    metadata: {
      generated_at: fetchedAt,
      stats_as_of: fetchedAt,
    },
    stats: {
      lifetime_tokens: 1_200_000,
      peak_daily_tokens: 80_000,
      longest_running_turn_sec: 3_661,
      current_streak_days: 6,
      longest_streak_days: 12,
      total_threads: 42,
      daily_usage_buckets: [
        { start_date: "2026-09-15", tokens: 12_000 },
      ],
    },
  }, fetchedAt);
  const cached = safeUsageCache({
    usage,
    stats: { ...stats, resetCreditsAvailable: 3 },
    access_token: "must-not-be-retained",
  });

  assert.equal(usage.primaryWindowMinutes, 300);
  assert.equal(usage.secondaryWindowMinutes, 10_080);
  assert.equal(usage.primaryUsedPercent, 7);
  assert.equal(stats.lifetimeTokens, 1_200_000);
  assert.deepEqual(stats.daily, [{ date: "2026-09-15", tokens: 12_000 }]);
  assert.equal(cached.stats.resetCreditsAvailable, 3);
  assert.doesNotMatch(JSON.stringify(cached), /must-not-be-retained/);
});

test("reset credits expose the next available expiry without exposing credit data", () => {
  const reset = mapResetCreditsPayload({
    available_count: 2,
    credits: [
      { id: "expired", status: "expired", expires_at: "2026-09-15T00:00:00.000Z" },
      { id: "later", status: "available", expires_at: "2026-10-04T00:00:00.000Z" },
      { id: "sooner", status: "available", expires_at: "2026-09-30T00:00:00.000Z" },
    ],
  }, Date.parse("2026-09-16T00:00:00.000Z"));
  assert.deepEqual(reset, {
    availableCount: 2,
    nextExpiresAt: "2026-09-30T00:00:00.000Z",
  });
});

test("reset credits accept the upstream top-level expiry when credit details are omitted", () => {
  const reset = mapResetCreditsPayload({
    available_count: 1,
    next_expires_at: "2026-09-30T00:00:00.000Z",
  }, Date.parse("2026-09-16T00:00:00.000Z"));
  assert.deepEqual(reset, {
    availableCount: 1,
    nextExpiresAt: "2026-09-30T00:00:00.000Z",
  });
});

test("a taskkill race succeeds when the exact official process has already exited", async () => {
  await terminateOfficialProcesses(identity, [{ ProcessId: 25376 }], {
    platform: "win32",
    timeoutMs: 100,
    intervalMs: 1,
    listProcesses: async () => [],
    execFileAsync: async () => {
      const error = new Error("taskkill: The process with the specified PID was not found");
      error.status = 1;
      error.stderr = "ERROR: The process with the specified PID was not found.";
      throw error;
    },
  });
});

test("the switcher imports the Codex Switcher store and atomically restarts the official app", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-switcher-"));
  const codexHome = path.join(root, ".codex");
  const storePath = path.join(root, ".codex-switcher", "accounts.json");
  const activityPath = path.join(root, "activity.json");
  const current = account("account-a", "alice@example.com", "a");
  const target = account("account-b", "bob@example.com", "b");
  writeJson(storePath, { version: 1, active_account_id: current.id, accounts: [current, target] });
  writeJson(path.join(codexHome, "auth.json"), {
    tokens: {
      id_token: "id-a-rotated",
      access_token: "access-a-rotated",
      refresh_token: "refresh-a-rotated",
      account_id: "workspace-a",
    },
    last_refresh: "2026-09-16T00:00:00.000Z",
  });

  let processes = [{ ProcessId: 4312, ExecutablePath: identity.Executable }];
  let launched = 0;
  let prepared = 0;
  let resumed = 0;
  const switcher = createAccountSwitcher({
    platform: "win32",
    codexHome,
    accountStorePath: storePath,
    activityPath,
    logger: logger(),
    resolveIdentity: async () => identity,
    listProcesses: async () => processes,
    terminateProcesses: async () => { processes = []; },
    launchApp: async () => { launched += 1; },
    beforeOfficialRestart: async () => { prepared += 1; return { wallpaper: true }; },
    afterOfficialRestart: async () => { resumed += 1; },
  });

  try {
    const initial = await switcher.snapshot();
    assert.equal(initial.activeAccountId, "account-a");
    assert.equal(initial.officialApp.running, true);
    assert.equal(initial.currentSession.managed, true);
    assert.doesNotMatch(JSON.stringify(initial), /id-a|access-a|refresh-a|id-b|access-b|refresh-b/);

    const switched = await switcher.switchAccount("account-b");
    assert.equal(switched.activeAccountId, "account-b");
    assert.equal(switched.officialApp.running, false);
    assert.equal(prepared, 1);
    assert.equal(resumed, 1);
    assert.equal(launched, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")).tokens.refresh_token, "refresh-b");
    assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).active_account_id, "account-b");
    assert.equal(switched.activity.totalSwitches, 1);
    assert.equal(switched.activity.recent[0].accountName, "bob");

    const launchesBeforeSameAccount = launched;
    const preparedBeforeSameAccount = prepared;
    const same = await switcher.switchAccount("account-b");
    assert.equal(same.activeAccountId, "account-b");
    assert.equal(launched, launchesBeforeSameAccount);
    assert.equal(prepared, preparedBeforeSameAccount);
    assert.equal(same.activity.totalSwitches, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("adding the current official Codex session creates a compatible managed account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-import-"));
  const codexHome = path.join(root, ".codex");
  const auth = {
    tokens: {
      id_token: fakeJwt({
        email: "carol@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-c",
          chatgpt_plan_type: "pro",
        },
      }),
      access_token: "access-c",
      refresh_token: "refresh-c",
      account_id: "workspace-c",
    },
  };
  writeJson(path.join(codexHome, "auth.json"), auth);
  const switcher = createAccountSwitcher({
    platform: "win32",
    codexHome,
    accountStorePath: path.join(root, ".codex-switcher", "accounts.json"),
    activityPath: path.join(root, "activity.json"),
    logger: logger(),
    resolveIdentity: async () => identity,
    listProcesses: async () => [],
  });

  try {
    const result = await switcher.addCurrentAccount();
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].email, "carol@example.com");
    assert.equal(result.accounts[0].plan, "pro");
    assert.equal(result.accounts[0].isActive, true);
    assert.equal(result.activity.totalSwitches, 0);
    assert.equal(result.activity.recent[0].kind, "import");
    assert.doesNotMatch(JSON.stringify(result), /access-c|refresh-c/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("adding an auth.json imports a compatible inactive account and removing it clears cached usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-file-import-"));
  const codexHome = path.join(root, ".codex");
  const storePath = path.join(root, ".codex-switcher", "accounts.json");
  const usageCachePath = path.join(root, "usage.json");
  const authFile = path.join(root, "other-auth.json");
  const current = account("account-a", "alice@example.com", "a");
  writeJson(storePath, { version: 1, active_account_id: current.id, accounts: [current] });
  writeJson(path.join(codexHome, "auth.json"), {
    tokens: {
      id_token: fakeJwt({
        email: "dana@example.com",
        picture: "https://avatars.example.com/dana.png",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-d",
          chatgpt_plan_type: "plus",
        },
      }),
      access_token: "access-current",
      refresh_token: "refresh-current",
      account_id: "workspace-a",
    },
  });
  writeJson(authFile, {
    tokens: {
      id_token: fakeJwt({
        email: "dana@example.com",
        picture: "https://avatars.example.com/dana.png",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-d",
          chatgpt_plan_type: "plus",
        },
      }),
      access_token: "access-d",
      refresh_token: "refresh-d",
      account_id: "workspace-d",
    },
  });
  writeJson(usageCachePath, {
    version: 1,
    accounts: { "imported-account": { usage: { available: true }, stats: { available: true } } },
  });
  const switcher = createAccountSwitcher({
    platform: "win32",
    codexHome,
    accountStorePath: storePath,
    activityPath: path.join(root, "activity.json"),
    usageCachePath,
    logger: logger(),
    resolveIdentity: async () => identity,
    listProcesses: async () => [],
  });

  try {
    const added = await switcher.addAccountFromFile(authFile);
    const imported = added.accounts.find(candidate => candidate.email === "dana@example.com");
    assert.ok(imported);
    assert.equal(imported.isActive, false);
    assert.equal(imported.avatarUrl, "https://avatars.example.com/dana.png");
    assert.doesNotMatch(JSON.stringify(added), /access-d|refresh-d/);

    writeJson(usageCachePath, {
      version: 1,
      accounts: { [imported.id]: { usage: { available: true }, stats: { available: true } } },
    });
    const removed = await switcher.removeAccount(imported.id);
    assert.equal(removed.accounts.some(candidate => candidate.id === imported.id), false);
    assert.equal(JSON.parse(fs.readFileSync(usageCachePath, "utf8")).accounts[imported.id], undefined);
    await assert.rejects(() => switcher.removeAccount("account-a"), /active account/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
