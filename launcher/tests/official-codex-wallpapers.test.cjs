const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  browserIdFromVersionPayload,
  createOfficialCodexWallpaperController,
  discoverOfficialTargets,
  endpointRecordLooksValid,
  officialAppTarget,
  providerAwareRateLimitGateScript,
  RATE_LIMIT_GATE_PROBE_SCRIPT,
  RATE_LIMIT_GATE_RECOVERY_SCRIPT,
  usageAllowsRateLimitRecovery,
  usageShowsNativeQuotaExhaustion,
} = require("../electron/official-codex-wallpapers.cjs");

const identity = Object.freeze({
  Version: "26.908.9136.0",
  Executable: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.9136.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
  AppId: "OpenAI.Codex_2p2nqsd0c76g0!ChatGPT",
});

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(raw) {
    const message = JSON.parse(raw);
    const value = message.params?.expression?.includes("performance.timeOrigin")
      ? "official-codex-generation-1"
      : true;
    queueMicrotask(() => this.onmessage?.({
      data: JSON.stringify({ id: message.id, result: { result: { value } } }),
    }));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

function scriptedWebSocket(responder) {
  return class ScriptedWebSocket extends FakeWebSocket {
    send(raw) {
      const message = JSON.parse(raw);
      const expression = message.params?.expression || "";
      const value = expression.includes("performance.timeOrigin")
        ? "official-codex-generation-1"
        : responder(expression);
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({ id: message.id, result: { result: { value } } }),
      }));
    }
  };
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

function validEndpoint(port = 9333) {
  return { port, browserId: "browser_1", version: identity.Version };
}

function makeProviderGateVmContext({
  disabled = true,
  ariaDisabled = "true",
  providerInsideRoot = true,
  providerIsSelectedControl = !providerInsideRoot,
} = {}) {
  class FakeElement {
    constructor({ text = "" } = {}) {
      this.innerText = text;
      this.textContent = text;
      this.attrs = new Map();
    }

    getBoundingClientRect() {
      return { width: 100, height: 40 };
    }

    getAttribute(name) {
      return this.attrs.has(name) ? this.attrs.get(name) : null;
    }

    setAttribute(name, value) {
      this.attrs.set(name, String(value));
    }

    removeAttribute(name) {
      this.attrs.delete(name);
    }
  }

  class FakeButton extends FakeElement {
    constructor(options = {}) {
      super(options);
      this.disabled = options.disabled === true;
    }
  }

  const submit = new FakeButton({ disabled });
  submit.setAttribute("type", "submit");
  if (ariaDisabled != null) submit.setAttribute("aria-disabled", ariaDisabled);
  const model = new FakeButton({ text: "ChatGPT Web — GPT-5.6 Sol" });
  if (providerIsSelectedControl) model.setAttribute("aria-haspopup", "menu");
  const editor = new FakeElement({ text: "hello" });
  const root = new FakeElement();
  root.querySelectorAll = selector => selector === "button"
    ? (providerInsideRoot ? [model, submit] : [submit])
    : [];
  root.querySelector = selector => {
    if (selector === 'button[type="submit"]') return submit;
    if (selector === '#prompt-textarea, [contenteditable="true"]') return editor;
    if (selector === ".composer-attachment-surface") return null;
    return null;
  };

  const context = {
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButton,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      documentElement: root,
      querySelectorAll: selector => selector === "button"
        ? [model, submit]
        : selector === 'button[aria-haspopup="menu"]'
          ? (providerIsSelectedControl ? [model] : [])
          : [root],
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    queueMicrotask,
  };
  context.globalThis = context;
  return { context, submit };
}

function makeTarget(id = "page_1", url = "app://codex/index.html") {
  return { id, url, webSocketUrl: `ws://127.0.0.1:9333/devtools/page/${id}` };
}

function makeManager(calls) {
  return {
    checkLibrary: async () => ({ count: 0 }),
    install: async () => {
      calls.install += 1;
      return { libraryCount: 0, transferred: 0, injected: true };
    },
    dispose: async () => { calls.dispose += 1; },
  };
}

function makeController({
  root,
  calls = { install: 0, dispose: 0 },
  events = [],
  processes = [],
  storedEndpoint = false,
  discoverTargets = async () => [],
  validateEndpoint = async () => storedEndpoint,
  launchApp = async () => {},
  waitForEndpoint = async () => validEndpoint(),
  findPort = async () => 9333,
  platform = "win32",
  WebSocketImpl = FakeWebSocket,
  getCurrentUsage = async () => null,
  now = () => Date.now(),
  refreshIntervalMs = 60_000,
} = {}) {
  const controller = createOfficialCodexWallpaperController({
    platform,
    dataRoot: root,
    logger: logger(),
    wallpaperManager: makeManager(calls),
    resolveIdentity: async () => identity,
    listProcesses: async () => processes,
    validateEndpoint,
    launchApp,
    waitForEndpoint,
    findPort,
    discoverTargets,
    WebSocketImpl,
    onStatus: status => events.push(status),
    getCurrentUsage,
    now,
    refreshIntervalMs,
    restartPollIntervalMs: 10,
  });
  if (storedEndpoint) fs.writeFileSync(path.join(root, "endpoint.json"), `${JSON.stringify(validEndpoint())}\n`);
  return controller;
}

test("stale rate-limit recovery requires fresh usage headroom", () => {
  assert.equal(usageAllowsRateLimitRecovery(null), false);
  assert.equal(usageAllowsRateLimitRecovery({ available: false, primaryUsedPercent: 10 }), false);
  assert.equal(usageAllowsRateLimitRecovery({ available: true, primaryUsedPercent: null, secondaryUsedPercent: null }), false);
  assert.equal(usageAllowsRateLimitRecovery({ available: true, primaryUsedPercent: 100, secondaryUsedPercent: 47 }), false);
  assert.equal(usageAllowsRateLimitRecovery({ available: true, primaryUsedPercent: 0, secondaryUsedPercent: 47 }), true);
  assert.equal(usageShowsNativeQuotaExhaustion(null), false);
  assert.equal(usageShowsNativeQuotaExhaustion({ available: false, primaryUsedPercent: 100 }), false);
  assert.equal(usageShowsNativeQuotaExhaustion({ available: true, primaryUsedPercent: 99, secondaryUsedPercent: 47 }), false);
  assert.equal(usageShowsNativeQuotaExhaustion({ available: true, primaryUsedPercent: 100, secondaryUsedPercent: 47 }), true);
});

test("ChatGPT Web provider gate handles a natively disabled quota button and restores it", () => {
  const { context, submit } = makeProviderGateVmContext({
    disabled: true,
    ariaDisabled: "true",
  });

  const probe = vm.runInNewContext(RATE_LIMIT_GATE_PROBE_SCRIPT, context);
  assert.equal(probe.rateLimitBlocked, true);
  assert.equal(probe.chatGptWebSelected, true);
  assert.equal(probe.hasSendableContent, true);

  const unlocked = vm.runInNewContext(providerAwareRateLimitGateScript(true), context);
  assert.equal(unlocked.managed, true);
  assert.equal(unlocked.unlocked, true);
  assert.equal(submit.disabled, false);
  assert.equal(submit.getAttribute("aria-disabled"), "false");
  assert.equal(submit.getAttribute("data-cw-chatgpt-web-quota-original-disabled"), "true");

  const restored = vm.runInNewContext(providerAwareRateLimitGateScript(false), context);
  assert.equal(restored.managed, false);
  assert.equal(restored.unlocked, false);
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute("aria-disabled"), "true");
  assert.equal(submit.getAttribute("data-cw-chatgpt-web-quota-unlock"), null);
});

test("ChatGPT Web provider gate detects the v6 provider control outside the composer", () => {
  const { context, submit } = makeProviderGateVmContext({
    disabled: true,
    ariaDisabled: null,
    providerInsideRoot: false,
  });

  const probe = vm.runInNewContext(RATE_LIMIT_GATE_PROBE_SCRIPT, context);
  assert.equal(probe.rateLimitBlocked, true);
  assert.equal(probe.chatGptWebSelected, true);
  assert.equal(probe.hasSendableContent, true);

  const unlocked = vm.runInNewContext(providerAwareRateLimitGateScript(true), context);
  assert.equal(unlocked.managed, true);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.selected, true);
  assert.equal(submit.disabled, false);
  assert.equal(submit.getAttribute("aria-disabled"), "false");
});

test("ChatGPT Web menu options outside the composer do not impersonate the selected provider", () => {
  const { context, submit } = makeProviderGateVmContext({
    disabled: true,
    ariaDisabled: "true",
    providerInsideRoot: false,
    providerIsSelectedControl: false,
  });

  const probe = vm.runInNewContext(RATE_LIMIT_GATE_PROBE_SCRIPT, context);
  assert.equal(probe.chatGptWebSelected, false);

  const gate = vm.runInNewContext(providerAwareRateLimitGateScript(true), context);
  assert.equal(gate.managed, false);
  assert.equal(gate.unlocked, false);
  assert.equal(gate.selected, false);
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute("aria-disabled"), "true");
});

test("ChatGPT Web provider gate unlocks send while native Codex quota is exhausted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-web-gate-"));
  let unlocked = false;
  let gateCalls = 0;
  let recoveryCalls = 0;
  let usageCalls = 0;
  let clock = 300_000;
  const WebSocketImpl = scriptedWebSocket(expression => {
    if (expression === RATE_LIMIT_GATE_PROBE_SCRIPT) {
      return {
        rateLimitBlocked: !unlocked,
        providerGateUnlocked: unlocked,
        chatGptWebSelected: true,
        hasSendableContent: true,
        hasAttachments: false,
      };
    }
    if (expression === providerAwareRateLimitGateScript(true)) {
      gateCalls += 1;
      unlocked = true;
      return { managed: true, unlocked: true, selected: true, sendable: true };
    }
    if (expression === RATE_LIMIT_GATE_RECOVERY_SCRIPT) {
      recoveryCalls += 1;
      return true;
    }
    return true;
  });
  const controller = makeController({
    root,
    storedEndpoint: true,
    processes: [{ ProcessId: 5678, ExecutablePath: identity.Executable }],
    discoverTargets: async () => [makeTarget()],
    WebSocketImpl,
    getCurrentUsage: async () => {
      usageCalls += 1;
      return {
        available: true,
        fetchedAt: "2026-09-23T00:34:00.000Z",
        primaryUsedPercent: 100,
        secondaryUsedPercent: 47,
      };
    },
    now: () => {
      clock += 2_000;
      return clock;
    },
    refreshIntervalMs: 10,
  });
  try {
    await controller.setEnabled(true);
    const deadline = Date.now() + 500;
    while (!unlocked && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(unlocked, true);
    assert.ok(gateCalls >= 1);
    assert.equal(usageCalls, 1);
    assert.equal(recoveryCalls, 0);
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native Codex models never receive the ChatGPT Web quota override", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-native-gate-"));
  let providerGateCalls = 0;
  let recoveryCalls = 0;
  let clock = 400_000;
  const WebSocketImpl = scriptedWebSocket(expression => {
    if (expression === RATE_LIMIT_GATE_PROBE_SCRIPT) {
      return {
        rateLimitBlocked: true,
        providerGateUnlocked: false,
        chatGptWebSelected: false,
        hasSendableContent: true,
        hasAttachments: false,
      };
    }
    if (expression === providerAwareRateLimitGateScript(true)
      || expression === providerAwareRateLimitGateScript(false)) {
      providerGateCalls += 1;
      return { managed: false, unlocked: false, selected: false, sendable: true };
    }
    if (expression === RATE_LIMIT_GATE_RECOVERY_SCRIPT) {
      recoveryCalls += 1;
      return true;
    }
    return true;
  });
  const controller = makeController({
    root,
    storedEndpoint: true,
    processes: [{ ProcessId: 5678, ExecutablePath: identity.Executable }],
    discoverTargets: async () => [makeTarget()],
    WebSocketImpl,
    getCurrentUsage: async () => ({
      available: true,
      primaryUsedPercent: 100,
      secondaryUsedPercent: 47,
    }),
    now: () => {
      clock += 2_000;
      return clock;
    },
    refreshIntervalMs: 10,
  });
  try {
    await controller.setEnabled(true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(providerGateCalls, 0);
    assert.equal(recoveryCalls, 0);
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale native rate-limit gate refreshes only after authoritative usage says send is available", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-rate-limit-"));
  const calls = { install: 0, dispose: 0 };
  let blocked = true;
  let recoveryCalls = 0;
  let usageCalls = 0;
  let clock = 100_000;
  const WebSocketImpl = scriptedWebSocket(expression => {
    if (expression === RATE_LIMIT_GATE_PROBE_SCRIPT) {
      return { rateLimitBlocked: blocked, hasAttachments: false };
    }
    if (expression === RATE_LIMIT_GATE_RECOVERY_SCRIPT) {
      recoveryCalls += 1;
      blocked = false;
      return true;
    }
    return true;
  });
  const controller = makeController({
    root,
    calls,
    storedEndpoint: true,
    processes: [{ ProcessId: 5678, ExecutablePath: identity.Executable }],
    discoverTargets: async () => [makeTarget()],
    WebSocketImpl,
    getCurrentUsage: async () => {
      usageCalls += 1;
      return {
        available: true,
        fetchedAt: "2026-09-22T23:20:00.000Z",
        primaryUsedPercent: 0,
        secondaryUsedPercent: 47,
      };
    },
    now: () => {
      clock += 2_000;
      return clock;
    },
    refreshIntervalMs: 10,
  });
  try {
    await controller.setEnabled(true);
    const deadline = Date.now() + 500;
    while (recoveryCalls === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(recoveryCalls, 1);
    assert.equal(usageCalls, 1);
    assert.equal(blocked, false);
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("genuine or attachment-bearing rate-limit states are never refreshed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-real-limit-"));
  let probeCount = 0;
  let recoveryCalls = 0;
  let usageCalls = 0;
  let clock = 200_000;
  const WebSocketImpl = scriptedWebSocket(expression => {
    if (expression === RATE_LIMIT_GATE_PROBE_SCRIPT) {
      probeCount += 1;
      return {
        rateLimitBlocked: true,
        hasAttachments: probeCount < 3,
      };
    }
    if (expression === RATE_LIMIT_GATE_RECOVERY_SCRIPT) {
      recoveryCalls += 1;
      return true;
    }
    return true;
  });
  const controller = makeController({
    root,
    storedEndpoint: true,
    processes: [{ ProcessId: 5678, ExecutablePath: identity.Executable }],
    discoverTargets: async () => [makeTarget()],
    WebSocketImpl,
    getCurrentUsage: async () => {
      usageCalls += 1;
      return {
        available: true,
        primaryUsedPercent: 100,
        secondaryUsedPercent: 47,
      };
    },
    now: () => {
      clock += 2_000;
      return clock;
    },
    refreshIntervalMs: 10,
  });
  try {
    await controller.setEnabled(true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(probeCount >= 3);
    assert.equal(usageCalls, 1);
    assert.equal(recoveryCalls, 0);
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official wallpaper endpoint identity rejects wrong version, browser id, and non-loopback websocket URLs", () => {
  const endpoint = validEndpoint();
  assert.equal(endpointRecordLooksValid(endpoint, identity), true);
  assert.equal(endpointRecordLooksValid({ ...endpoint, version: "26.0.0.0" }, identity), false);
  assert.equal(endpointRecordLooksValid({ ...endpoint, browserId: "bad browser id" }, identity), false);
  assert.equal(browserIdFromVersionPayload({
    webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/browser_1",
  }, 9333), "browser_1");
  assert.equal(browserIdFromVersionPayload({
    webSocketDebuggerUrl: "ws://192.168.1.10:9333/devtools/browser/browser_1",
  }, 9333), null);
  assert.equal(browserIdFromVersionPayload({
    webSocketDebuggerUrl: "ws://127.0.0.1:9334/devtools/browser/browser_1",
  }, 9333), null);
});

test("official target discovery keeps only page targets inside the Store app surface", async () => {
  const targets = [
    { id: "page_1", type: "page", url: "app://codex/index.html" },
    { id: "avatar_overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay" },
    { id: "detached_window", type: "page", url: "app://-/detached-window.html?initialRoute=%2Fdetached-window" },
    { id: "external", type: "page", url: "https://chatgpt.com/" },
    { id: "frame_1", type: "iframe", url: "app://codex/frame.html" },
    { id: "bad id", type: "page", url: "app://codex/bad.html" },
  ];
  const result = await discoverOfficialTargets(validEndpoint(), async () => ({
    ok: true,
    json: async () => targets,
  }));
  assert.deepEqual(result, [makeTarget("page_1")]);
  assert.equal(officialAppTarget(targets[0], 9333), true);
  assert.equal(officialAppTarget(targets[1], 9333), false);
  assert.equal(officialAppTarget(targets[2], 9333), false);
  assert.equal(officialAppTarget(targets[3], 9333), false);
});

test("enabling while the official Store app is already open waits for a user restart and never launches or kills it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-open-"));
  let launched = 0;
  const events = [];
  const controller = makeController({
    root,
    events,
    processes: [{ ProcessId: 1234, ExecutablePath: identity.Executable }],
    launchApp: async () => { launched += 1; },
  });
  try {
    const result = await controller.setEnabled(true);
    assert.equal(result.enabled, true);
    assert.equal(result.restartRequired, true);
    assert.equal(launched, 0);
    assert.equal(events.at(-1).status, "restart-required");
    assert.equal(events.at(-1).restartRequired, true);
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a fast normal restart is detected and retried with the official CDP launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-fast-restart-"));
  const processes = [{ ProcessId: 1234, ExecutablePath: identity.Executable }];
  const events = [];
  let launched = 0;
  const controller = makeController({
    root,
    events,
    processes,
    launchApp: async () => { launched += 1; },
    waitForEndpoint: async (_nextIdentity, port) => validEndpoint(port),
  });
  try {
    const initial = await controller.setEnabled(true);
    assert.equal(initial.restartRequired, true);
    processes.splice(0, processes.length, { ProcessId: 5678, ExecutablePath: identity.Executable });
    const deadline = Date.now() + 500;
    while (launched === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(launched, 1);
    assert.equal(events.at(-1).status, "ready");
    assert.equal(events.at(-1).restartRequired, false);
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enabling with the official Store app closed launches it on a loopback CDP port", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-launch-"));
  const calls = { install: 0, dispose: 0 };
  const events = [];
  const launches = [];
  const controller = makeController({
    root,
    calls,
    events,
    processes: [],
    findPort: async () => 9444,
    launchApp: async (nextIdentity, port) => launches.push({ nextIdentity, port }),
    waitForEndpoint: async (_nextIdentity, port) => validEndpoint(port),
  });
  try {
    const result = await controller.setEnabled(true);
    assert.equal(result.enabled, true);
    assert.equal(result.restartRequired, false);
    assert.equal(result.applied, 0);
    assert.deepEqual(launches, [{ nextIdentity: identity, port: 9444 }]);
    assert.equal(events.at(-1).status, "ready");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "endpoint.json"), "utf8")), validEndpoint(9444));
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enabling attaches and injects only the official app targets, and disabling disposes without closing the app", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-attach-"));
  const calls = { install: 0, dispose: 0 };
  const events = [];
  let launchCount = 0;
  let discoveryCount = 0;
  const controller = makeController({
    root,
    calls,
    events,
    storedEndpoint: true,
    processes: [{ ProcessId: 5678, ExecutablePath: identity.Executable }],
    launchApp: async () => { launchCount += 1; },
    discoverTargets: async () => {
      discoveryCount += 1;
      return [makeTarget()];
    },
    refreshIntervalMs: 10,
  });
  try {
    const enabled = await controller.setEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.restartRequired, false);
    assert.equal(enabled.applied, 1);
    assert.equal(calls.install, 1);
    assert.equal(launchCount, 0);
    const discoveriesBeforeDisable = discoveryCount;
    const disabled = await controller.setEnabled(false);
    assert.equal(disabled.enabled, false);
    assert.equal(calls.dispose, 1);
    assert.equal(events.at(-1).status, "disabled");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(discoveryCount, discoveriesBeforeDisable);
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official wallpaper integration is unavailable outside Windows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-wallpapers-platform-"));
  let launched = false;
  const controller = makeController({
    root,
    platform: "linux",
    launchApp: async () => { launched = true; },
  });
  try {
    await assert.rejects(controller.setEnabled(true), /Windows only/);
    assert.equal(launched, false);
    const disabled = await controller.setEnabled(false);
    assert.equal(disabled.enabled, false);
  } finally {
    controller.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
