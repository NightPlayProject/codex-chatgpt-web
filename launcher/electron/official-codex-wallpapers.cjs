const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { createWallpaperManager, wallpaperDataRoot } = require("./wallpapers.cjs");

const execFileAsync = promisify(execFile);
const TARGET_REFRESH_INTERVAL_MS = 2_000;
const RESTART_POLL_INTERVAL_MS = 2_000;
const RATE_LIMIT_STALE_CONFIRM_MS = 1_500;
const RATE_LIMIT_USAGE_RECHECK_MS = 30_000;
const RATE_LIMIT_RECOVERY_COOLDOWN_MS = 60_000;
const ENDPOINT_CONNECT_TIMEOUT_MS = 40_000;
const ENDPOINT_POLL_INTERVAL_MS = 400;
const POWERSHELL_TIMEOUT_MS = 12_000;
const CDP_CALL_TIMEOUT_MS = 20_000;
const TARGET_ID_RE = /^[A-Za-z0-9_-]+$/;

const RATE_LIMIT_GATE_PROBE_SCRIPT = String.raw`(() => {
  const roots = [...document.querySelectorAll('form[data-type="unified-composer"], [data-composer-surface-variant], [data-composer-layout]')];
  const visible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const root = roots.filter(visible).at(-1) || null;
  const button = root?.querySelector('button[type="submit"]') || null;
  const chatGptWebSelected = root instanceof Element && [...root.querySelectorAll('button')]
    .filter(candidate => candidate !== button && visible(candidate))
    .some(candidate => /^ChatGPT Web(?:\s*[—-]|\s|$)/i.test((candidate.innerText || candidate.textContent || '').replace(/\s+/g, ' ').trim()));
  const editor = root?.querySelector('#prompt-textarea, [contenteditable="true"]') || null;
  const editorText = editor instanceof HTMLElement ? (editor.innerText || editor.textContent || '') : '';
  const hasAttachments = root instanceof Element && root.querySelector('.composer-attachment-surface') != null;
  return {
    rateLimitBlocked: button instanceof HTMLButtonElement
      && button.getAttribute('aria-disabled') === 'true',
    providerGateUnlocked: button instanceof HTMLButtonElement
      && button.getAttribute('data-cw-chatgpt-web-quota-unlock') === 'true',
    chatGptWebSelected,
    hasSendableContent: editorText.trim().length > 0 || hasAttachments,
    hasAttachments,
  };
})()`;

const RATE_LIMIT_GATE_RECOVERY_SCRIPT = String.raw`(() => {
  const roots = [...document.querySelectorAll('form[data-type="unified-composer"], [data-composer-surface-variant], [data-composer-layout]')];
  const visible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const root = roots.filter(visible).at(-1) || null;
  const button = root?.querySelector('button[type="submit"][aria-disabled="true"]') || null;
  const stillRateLimited = button instanceof HTMLButtonElement && button.disabled === false;
  if (!stillRateLimited || root.querySelector('.composer-attachment-surface') != null) return false;
  location.reload();
  return true;
})()`;

function providerAwareRateLimitGateScript(nativeQuotaBlocked) {
  const blocked = nativeQuotaBlocked === true ? "true" : "false";
  return String.raw`(() => {
    const key = '__codexWebGptProviderRateLimitGate';
    let state = globalThis[key];
    if (!state || state.version !== 2 || typeof state.sync !== 'function') {
      try { state?.observer?.disconnect?.(); } catch {}
      state = {
        version: 2,
        nativeQuotaBlocked: false,
        scheduled: false,
        observer: null,
        sync: null,
        schedule: null,
      };
      const visible = element => {
        if (!(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      state.sync = () => {
        const roots = [...document.querySelectorAll('form[data-type="unified-composer"], [data-composer-surface-variant], [data-composer-layout]')];
        const root = roots.filter(visible).at(-1) || null;
        const button = root?.querySelector('button[type="submit"]') || null;
        if (!(root instanceof Element) || !(button instanceof HTMLButtonElement)) {
          return { managed: false, unlocked: false, selected: false, sendable: false };
        }
        const selected = [...root.querySelectorAll('button')]
          .filter(candidate => candidate !== button && visible(candidate))
          .some(candidate => /^ChatGPT Web(?:\s*[—-]|\s|$)/i.test((candidate.innerText || candidate.textContent || '').replace(/\s+/g, ' ').trim()));
        const editor = root.querySelector('#prompt-textarea, [contenteditable="true"]');
        const editorText = editor instanceof HTMLElement ? (editor.innerText || editor.textContent || '') : '';
        const hasAttachments = root.querySelector('.composer-attachment-surface') != null;
        const sendable = editorText.trim().length > 0 || hasAttachments;
        const marked = button.getAttribute('data-cw-chatgpt-web-quota-unlock') === 'true';
        const shouldUnlock = state.nativeQuotaBlocked === true
          && selected
          && sendable;
        if (shouldUnlock) {
          if (!marked) {
            button.setAttribute(
              'data-cw-chatgpt-web-quota-original-disabled',
              button.disabled === true ? 'true' : 'false',
            );
            const originalAriaDisabled = button.getAttribute('aria-disabled');
            button.setAttribute(
              'data-cw-chatgpt-web-quota-original-aria-disabled',
              originalAriaDisabled == null ? '__null__' : originalAriaDisabled,
            );
          }
          button.setAttribute('data-cw-chatgpt-web-quota-unlock', 'true');
          button.disabled = false;
          button.setAttribute('aria-disabled', 'false');
        } else if (!shouldUnlock && marked) {
          button.disabled = button.getAttribute('data-cw-chatgpt-web-quota-original-disabled') === 'true';
          const originalAriaDisabled = button.getAttribute('data-cw-chatgpt-web-quota-original-aria-disabled');
          if (originalAriaDisabled === '__null__') {
            button.removeAttribute('aria-disabled');
          } else if (originalAriaDisabled != null) {
            button.setAttribute('aria-disabled', originalAriaDisabled);
          }
          button.removeAttribute('data-cw-chatgpt-web-quota-unlock');
          button.removeAttribute('data-cw-chatgpt-web-quota-original-disabled');
          button.removeAttribute('data-cw-chatgpt-web-quota-original-aria-disabled');
        }
        return {
          managed: button.getAttribute('data-cw-chatgpt-web-quota-unlock') === 'true',
          unlocked: button.disabled === false && button.getAttribute('aria-disabled') !== 'true',
          selected,
          sendable,
        };
      };
      state.schedule = () => {
        if (state.scheduled) return;
        state.scheduled = true;
        queueMicrotask(() => {
          state.scheduled = false;
          try { state.sync(); } catch {}
        });
      };
      state.observer = new MutationObserver(state.schedule);
      state.observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-disabled', 'disabled', 'class'],
      });
      globalThis[key] = state;
    }
    state.nativeQuotaBlocked = ${blocked};
    return state.sync();
  })()`;
}

function usageShowsNativeQuotaExhaustion(usage) {
  if (!usage || usage.available !== true) return false;
  const windows = [usage.primaryUsedPercent, usage.secondaryUsedPercent]
    .filter(value => Number.isFinite(value));
  return windows.length > 0 && windows.some(value => value >= 100);
}

function usageAllowsRateLimitRecovery(usage) {
  if (!usage || usage.available !== true) return false;
  const windows = [usage.primaryUsedPercent, usage.secondaryUsedPercent]
    .filter(value => Number.isFinite(value));
  return windows.length > 0 && windows.every(value => value < 100);
}

const STORE_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$package=Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1
if(-not $package -or $package.SignatureKind -ne 'Store' -or $package.IsDevelopmentMode){throw 'Official Microsoft Store Codex package unavailable.'}
$manifest=Get-AppxPackageManifest -Package $package
$apps=@($manifest.Package.Applications.Application | Where-Object {$_.Executable.Replace('/','\') -eq 'app\ChatGPT.exe'})
if($apps.Count -ne 1){throw 'Unsupported official Codex application manifest.'}
$exe=Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if(-not(Test-Path -LiteralPath $exe)){throw 'Official Codex executable unavailable.'}
[pscustomobject]@{Version="$($package.Version)";Executable=$exe;Root=$package.InstallLocation;AppId="$($package.PackageFamilyName)!$($apps[0].Id)";Family=$package.PackageFamilyName}|ConvertTo-Json -Compress
`;

const STORE_PROCESSES_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$rows=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction Stop | Where-Object {$_.ExecutablePath -eq $env:CW_EXPECTED_EXE} | Select-Object ProcessId,ExecutablePath)
ConvertTo-Json -Compress -InputObject @($rows)
`;

const VERIFY_ENDPOINT_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$endpoint=$env:CW_ENDPOINT_JSON|ConvertFrom-Json
if($endpoint.port -lt 1024 -or $endpoint.port -gt 65535){throw 'Invalid endpoint port.'}
if($endpoint.version -ne $env:CW_EXPECTED_VERSION){throw 'Package changed after endpoint creation.'}
if($endpoint.browserId -notmatch '^[A-Za-z0-9_-]+$'){throw 'Invalid endpoint browser identity.'}
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort $endpoint.port -ErrorAction SilentlyContinue)
if(-not $listeners.Count){throw 'No local endpoint.'}
foreach($listener in $listeners){
 if($listener.LocalAddress -notin @('127.0.0.1','::1')){throw 'Non-loopback endpoint rejected.'}
 $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
 if($owner.ExecutablePath -ne $env:CW_EXPECTED_EXE){throw 'Endpoint does not belong to the official Codex package.'}
}
$version=Invoke-RestMethod "http://127.0.0.1:$($endpoint.port)/json/version" -TimeoutSec 3 -MaximumRedirection 0
$uri=[Uri]$version.webSocketDebuggerUrl
if($uri.Host -notin @('127.0.0.1','localhost','::1') -or $uri.Port -ne $endpoint.port -or $uri.AbsolutePath -ne "/devtools/browser/$($endpoint.browserId)"){throw 'Endpoint identity mismatch.'}
[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress
`;

const LAUNCH_STORE_APP_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
if(-not ('CWPackageActivation' -as [type])){Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CWPackageActivation {
 [ComImport,Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Manager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id,[MarshalAs(UnmanagedType.LPWStr)] string args,uint options,out uint pid);
 }
 [ComImport,Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c")] class ActivationManager {}
 public static void Open(string id,string args){var manager=(Manager)new ActivationManager();try{uint pid;Marshal.ThrowExceptionForHR(manager.ActivateApplication(id,args,0,out pid));}finally{Marshal.ReleaseComObject(manager);}}
}
'@}
[CWPackageActivation]::Open($env:CW_APP_ID,$env:CW_ARGS)
[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress
`;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPowerShellJson(script, { env = {}, timeoutMs = POWERSHELL_TIMEOUT_MS } = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env },
    },
  );
  const output = String(stdout || "").trim();
  return output ? JSON.parse(output) : null;
}

async function resolveOfficialCodexIdentity() {
  return runPowerShellJson(STORE_IDENTITY_SCRIPT);
}

async function listOfficialCodexProcesses(identity) {
  const rows = await runPowerShellJson(STORE_PROCESSES_SCRIPT, {
    env: { CW_EXPECTED_EXE: identity.Executable },
  });
  if (!Array.isArray(rows)) throw new Error("Official Codex process query returned an invalid result");
  return rows;
}

function processIdentitySet(processes) {
  return new Set((Array.isArray(processes) ? processes : [])
    .map(process => process?.ProcessId ?? process?.pid)
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value)));
}

function endpointRecordLooksValid(endpoint, identity) {
  return Boolean(endpoint
    && Number.isInteger(endpoint.port)
    && endpoint.port >= 1024
    && endpoint.port <= 65535
    && typeof endpoint.browserId === "string"
    && TARGET_ID_RE.test(endpoint.browserId)
    && endpoint.version === identity.Version);
}

async function validateOfficialEndpoint(endpoint, identity) {
  if (!endpointRecordLooksValid(endpoint, identity)) return false;
  try {
    const result = await runPowerShellJson(VERIFY_ENDPOINT_SCRIPT, {
      env: {
        CW_ENDPOINT_JSON: JSON.stringify(endpoint),
        CW_EXPECTED_EXE: identity.Executable,
        CW_EXPECTED_VERSION: identity.Version,
      },
    });
    return result?.ok === true;
  } catch {
    return false;
  }
}

async function launchOfficialCodex(identity, port) {
  return launchOfficialCodexApplication(
    identity,
    `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  );
}

async function launchOfficialCodexApplication(identity, args = "") {
  await runPowerShellJson(LAUNCH_STORE_APP_SCRIPT, {
    env: { CW_APP_ID: identity.AppId, CW_ARGS: String(args) },
  });
}

function findLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url, fetchImpl = globalThis.fetch, timeoutMs = 4_000) {
  if (typeof fetchImpl !== "function") throw new Error("HTTP client is unavailable for Codex Wallpapers");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function browserIdFromVersionPayload(payload, port) {
  if (!payload || typeof payload.webSocketDebuggerUrl !== "string") return null;
  let url;
  try { url = new URL(payload.webSocketDebuggerUrl); } catch { return null; }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || Number(url.port) !== port) return null;
  const prefix = "/devtools/browser/";
  if (!url.pathname.startsWith(prefix)) return null;
  const browserId = url.pathname.slice(prefix.length);
  return TARGET_ID_RE.test(browserId) ? browserId : null;
}

async function waitForOfficialEndpoint(identity, port, {
  fetchImpl = globalThis.fetch,
  validateEndpoint = validateOfficialEndpoint,
  timeoutMs = ENDPOINT_CONNECT_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const payload = await fetchJson(`http://127.0.0.1:${port}/json/version`, fetchImpl, 2_000);
      const browserId = browserIdFromVersionPayload(payload, port);
      if (browserId) {
        const endpoint = { port, browserId, version: identity.Version };
        if (await validateEndpoint(endpoint, identity)) return endpoint;
      }
    } catch {}
    if (Date.now() < deadline) await delay(ENDPOINT_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return null;
}

function officialAppTarget(target, port) {
  if (!(target
    && target.type === "page"
    && typeof target.url === "string"
    && target.url.startsWith("app://")
    && typeof target.id === "string"
    && TARGET_ID_RE.test(target.id)
    && Number.isInteger(port)
    && port >= 1024
    && port <= 65535)) {
    return false;
  }

  // The official desktop app exposes auxiliary Electron pages over the same
  // DevTools endpoint as the main Codex surface. Those pages (for example the
  // avatar overlay and detached window) intentionally do not contain the main
  // ChatGPT shell, so trying to install Wallpapers into them can only time out
  // and produces a repeated target_failed warning on every refresh.
  try {
    const url = new URL(target.url);
    if (!url.pathname.endsWith("/index.html")) return false;
    if (url.searchParams.get("initialRoute") === "/avatar-overlay") return false;
    return true;
  } catch {
    return false;
  }
}

async function discoverOfficialTargets(endpoint, fetchImpl = globalThis.fetch) {
  const targets = await fetchJson(`http://127.0.0.1:${endpoint.port}/json/list`, fetchImpl);
  if (!Array.isArray(targets)) throw new Error("Official Codex target list is invalid");
  return targets.filter(target => officialAppTarget(target, endpoint.port)).map(target => ({
    id: target.id,
    url: target.url,
    webSocketUrl: `ws://127.0.0.1:${endpoint.port}/devtools/page/${target.id}`,
  }));
}

class CdpContents {
  constructor(url, WebSocketImpl = globalThis.WebSocket) {
    if (typeof WebSocketImpl !== "function") throw new Error("WebSocket client is unavailable for Codex Wallpapers");
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.closed = false;
    this.connecting = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  isDestroyed() {
    return this.closed;
  }

  async connect() {
    if (this.closed) throw new Error("Official Codex CDP target is closed");
    if (this.socket?.readyState === 1) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.url);
      const fail = error => {
        if (this.socket === socket) this.socket = null;
        reject(error instanceof Error ? error : new Error("Official Codex CDP connection failed"));
      };
      socket.onopen = () => {
        this.socket = socket;
        resolve();
      };
      socket.onerror = () => fail(new Error("Official Codex CDP connection failed"));
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        const error = new Error("Official Codex CDP target closed");
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      };
      socket.onmessage = event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!Number.isInteger(message?.id)) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || "Official Codex CDP command failed"));
        else pending.resolve(message.result);
      };
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async executeJavaScript(expression) {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) throw new Error("Official Codex CDP target is unavailable");
    const id = ++this.sequence;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Official Codex CDP command timed out"));
      }, CDP_CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      }));
    });
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "JavaScript evaluation failed";
      throw new Error(description);
    }
    return result?.result?.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Official Codex CDP target closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try { this.socket?.close(); } catch {}
    this.socket = null;
  }
}

function readEndpointRecord(filePath) {
  try {
    return JSON.parse(require("node:fs").readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function createOfficialCodexWallpaperController({
  logger = { info() {}, warn() {}, error() {} },
  platform = process.platform,
  dataRoot = wallpaperDataRoot(),
  wallpaperManager = createWallpaperManager({ dataRoot }),
  resolveIdentity = resolveOfficialCodexIdentity,
  listProcesses = listOfficialCodexProcesses,
  validateEndpoint = validateOfficialEndpoint,
  launchApp = launchOfficialCodex,
  waitForEndpoint = waitForOfficialEndpoint,
  findPort = findLoopbackPort,
  discoverTargets = discoverOfficialTargets,
  WebSocketImpl = globalThis.WebSocket,
  onStatus = () => {},
  getCurrentUsage = async () => null,
  now = () => Date.now(),
  refreshIntervalMs = TARGET_REFRESH_INTERVAL_MS,
  restartPollIntervalMs = RESTART_POLL_INTERVAL_MS,
} = {}) {
  const resolvedDataRoot = path.resolve(dataRoot);
  const endpointPath = path.join(resolvedDataRoot, "endpoint.json");
  const sessions = new Map();
  let enabled = false;
  let endpoint = null;
  let identity = null;
  let refreshTimer = null;
  let restartTimer = null;
  let refreshInFlight = false;
  let endpointFailures = 0;
  let operation = Promise.resolve();
  let status = "disabled";
  let restartRequired = false;
  let lastError = null;
  let restartBaseline = null;

  const readRateLimitUsage = async (entry, targetId, checkedAt) => {
    if ((entry.rateLimitUsageCheckedAt || 0) > 0
      && checkedAt - entry.rateLimitUsageCheckedAt < RATE_LIMIT_USAGE_RECHECK_MS) {
      return entry.rateLimitUsage ?? null;
    }
    entry.rateLimitUsageCheckedAt = checkedAt;
    const usage = await getCurrentUsage().catch(error => {
      logger.warn("wallpapers.official_codex_rate_limit_usage_failed", {
        targetId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    entry.rateLimitUsage = usage;
    if (usage?.available === true
      && [usage.primaryUsedPercent, usage.secondaryUsedPercent].some(value => Number.isFinite(value))) {
      entry.nativeQuotaBlocked = usageShowsNativeQuotaExhaustion(usage);
    }
    return usage;
  };

  const maybeRecoverStaleRateLimit = async (entry, targetId) => {
    const checkedAt = now();
    const probe = await entry.contents.executeJavaScript(RATE_LIMIT_GATE_PROBE_SCRIPT);
    if (!probe) {
      entry.rateLimitBlockedSince = null;
      return false;
    }

    const providerGateCandidate = probe.chatGptWebSelected === true
      && probe.hasSendableContent === true
      && (probe.rateLimitBlocked === true || probe.providerGateUnlocked === true);
    let usage = null;
    if (providerGateCandidate) {
      usage = await readRateLimitUsage(entry, targetId, checkedAt);
      if (entry.nativeQuotaBlocked === true) {
        const gate = await entry.contents.executeJavaScript(providerAwareRateLimitGateScript(true));
        entry.rateLimitBlockedSince = null;
        if (gate?.managed === true && entry.providerGateActive !== true) {
          entry.providerGateActive = true;
          logger.info("wallpapers.official_codex_chatgpt_web_rate_limit_gate_unlocked", {
            targetId,
            usageFetchedAt: usage?.fetchedAt ?? null,
            primaryUsedPercent: usage?.primaryUsedPercent ?? null,
            secondaryUsedPercent: usage?.secondaryUsedPercent ?? null,
          });
        }
        return gate?.unlocked === true;
      }
      if (probe.providerGateUnlocked === true) {
        await entry.contents.executeJavaScript(providerAwareRateLimitGateScript(false));
        entry.providerGateActive = false;
      }
    } else if (probe.providerGateUnlocked === true) {
      // A native model must never inherit the ChatGPT Web override. The renderer-side
      // observer normally restores this immediately on model switch; this is a bounded
      // fallback if React replaced the model control before the observer ran.
      await entry.contents.executeJavaScript(providerAwareRateLimitGateScript(false));
      entry.providerGateActive = false;
    }

    const rateLimitBlocked = probe.rateLimitBlocked === true
      || (probe.providerGateUnlocked === true && entry.nativeQuotaBlocked === false);
    if (!rateLimitBlocked) {
      entry.rateLimitBlockedSince = null;
      return false;
    }
    entry.rateLimitBlockedSince ??= checkedAt;
    if (probe.hasAttachments === true) return false;
    if (checkedAt - entry.rateLimitBlockedSince < RATE_LIMIT_STALE_CONFIRM_MS) return false;
    if ((entry.rateLimitRecoveryCooldownUntil || 0) > checkedAt) return false;
    usage ??= await readRateLimitUsage(entry, targetId, checkedAt);
    if (!usageAllowsRateLimitRecovery(usage)) return false;
    entry.rateLimitRecoveryCooldownUntil = checkedAt + RATE_LIMIT_RECOVERY_COOLDOWN_MS;
    const recovered = await entry.contents.executeJavaScript(RATE_LIMIT_GATE_RECOVERY_SCRIPT);
    if (recovered !== true) return false;
    entry.generation = null;
    entry.rateLimitBlockedSince = null;
    logger.info("wallpapers.official_codex_rate_limit_state_refreshed", {
      targetId,
      usageFetchedAt: usage?.fetchedAt ?? null,
      primaryUsedPercent: usage?.primaryUsedPercent ?? null,
      secondaryUsedPercent: usage?.secondaryUsedPercent ?? null,
    });
    return true;
  };

  const publish = patch => {
    if (typeof patch.status === "string") status = patch.status;
    if (Object.prototype.hasOwnProperty.call(patch, "restartRequired")) {
      restartRequired = patch.restartRequired === true;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "error")) {
      lastError = patch.error == null ? null : String(patch.error);
    }
    try {
      onStatus({ enabled, status, restartRequired, error: lastError, ...patch });
    } catch {}
  };

  const closeSessions = () => {
    for (const entry of sessions.values()) entry.contents.close();
    sessions.clear();
  };

  const stopRefresh = () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    refreshInFlight = false;
    endpointFailures = 0;
    closeSessions();
    endpoint = null;
  };

  const stopRestartWait = () => {
    if (restartTimer) clearInterval(restartTimer);
    restartTimer = null;
    restartBaseline = null;
  };

  const refreshTargets = async () => {
    if (!enabled || !endpoint || refreshInFlight) return 0;
    refreshInFlight = true;
    try {
      const targets = await discoverTargets(endpoint);
      const alive = new Set(targets.map(target => target.id));
      for (const [id, entry] of sessions) {
        if (!alive.has(id)) {
          entry.contents.close();
          sessions.delete(id);
        }
      }
      let applied = 0;
      for (const target of targets) {
        let entry = sessions.get(target.id);
        if (!entry || entry.contents.isDestroyed()) {
          entry = {
            contents: new CdpContents(target.webSocketUrl, WebSocketImpl),
            generation: null,
            rateLimitBlockedSince: null,
            rateLimitUsageCheckedAt: 0,
            rateLimitUsage: null,
            nativeQuotaBlocked: null,
            providerGateActive: false,
            rateLimitRecoveryCooldownUntil: 0,
          };
          sessions.set(target.id, entry);
        }
        try {
          const generation = await entry.contents.executeJavaScript("String(performance.timeOrigin)");
          if (generation !== entry.generation) {
            const result = await wallpaperManager.install(entry.contents);
            entry.generation = generation;
            applied += 1;
            logger.info("wallpapers.official_codex_applied", {
              targetId: target.id,
              libraryCount: result?.libraryCount ?? 0,
              transferred: result?.transferred ?? 0,
              injected: result?.injected === true,
            });
          }
          await maybeRecoverStaleRateLimit(entry, target.id);
        } catch (error) {
          logger.warn("wallpapers.official_codex_target_failed", {
            targetId: target.id,
            message: error instanceof Error ? error.message : String(error),
          });
          entry.contents.close();
          sessions.delete(target.id);
        }
      }
      endpointFailures = 0;
      return applied;
    } catch (error) {
      endpointFailures += 1;
      logger.warn("wallpapers.official_codex_refresh_failed", {
        failures: endpointFailures,
        message: error instanceof Error ? error.message : String(error),
      });
      if (endpointFailures >= 3 && enabled && identity) {
        const processes = await listProcesses(identity).catch(() => []);
        stopRefresh();
        beginRestartWait(identity, processes);
        publish({ status: "restart-required", restartRequired: true, error: null });
      }
      return 0;
    } finally {
      refreshInFlight = false;
    }
  };

  const startRefresh = async (nextIdentity, nextEndpoint) => {
    stopRefresh();
    stopRestartWait();
    identity = nextIdentity;
    endpoint = nextEndpoint;
    const applied = await refreshTargets();
    if (enabled && endpoint && !refreshTimer) {
      refreshTimer = setInterval(() => { void refreshTargets(); }, refreshIntervalMs);
      refreshTimer.unref?.();
    }
    publish({ status: "ready", restartRequired: false, error: null, applied });
    return applied;
  };

  const writeEndpoint = record => {
    writePrivateFileAtomic(endpointPath, `${JSON.stringify(record, null, 2)}\n`);
  };

  const attachStoredEndpoint = async nextIdentity => {
    const stored = readEndpointRecord(endpointPath);
    if (!stored || !await validateEndpoint(stored, nextIdentity)) return null;
    return stored;
  };

  const launchAndAttach = async nextIdentity => {
    const port = await findPort();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Could not allocate a loopback port for the official Codex app");
    await launchApp(nextIdentity, port);
    if (!enabled) return { enabled: false, restartRequired: false, applied: 0, status, error: lastError };
    const nextEndpoint = await waitForEndpoint(nextIdentity, port, { validateEndpoint });
    if (!nextEndpoint) {
      beginRestartWait(nextIdentity);
      publish({ status: "restart-required", restartRequired: true, error: null });
      return { enabled: true, restartRequired: true, applied: 0, status, error: lastError };
    }
    writeEndpoint(nextEndpoint);
    const applied = await startRefresh(nextIdentity, nextEndpoint);
    return { enabled: true, restartRequired: false, applied, status, error: lastError };
  };

  function beginRestartWait(nextIdentity, baselineProcesses = null) {
    identity = nextIdentity;
    if (!enabled || restartTimer) return;
    restartBaseline = processIdentitySet(baselineProcesses);
    restartTimer = setInterval(async () => {
      if (!enabled || restartTimer === null) return;
      try {
        const stored = await attachStoredEndpoint(nextIdentity);
        if (stored) {
          await startRefresh(nextIdentity, stored);
          return;
        }
        const processes = await listProcesses(nextIdentity);
        const currentProcesses = processIdentitySet(processes);
        const baselineStillRunning = restartBaseline !== null
          && [...restartBaseline].some(processId => currentProcesses.has(processId));
        const restartWasObserved = restartBaseline !== null
          && restartBaseline.size > 0
          && currentProcesses.size > 0
          && !baselineStillRunning;
        if (processes.length !== 0 && !restartWasObserved) return;
        stopRestartWait();
        const result = await launchAndAttach(nextIdentity);
        if (result.restartRequired) {
          const nextProcesses = await listProcesses(nextIdentity).catch(() => []);
          beginRestartWait(nextIdentity, nextProcesses);
        }
      } catch (error) {
        logger.warn("wallpapers.official_codex_restart_wait_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        if (enabled && restartTimer === null) {
          beginRestartWait(nextIdentity);
        }
      }
    }, restartPollIntervalMs);
    restartTimer.unref?.();
  }

  async function prepareExternalRestart() {
    if (!enabled) return null;
    const nextIdentity = identity || await resolveIdentity();
    stopRestartWait();
    stopRefresh();
    identity = nextIdentity;
    publish({ status: "restarting", restartRequired: false, error: null });
    return { identity: nextIdentity };
  }

  async function resumeExternalRestart() {
    if (!enabled) return null;
    const nextIdentity = identity || await resolveIdentity();
    return launchAndAttach(nextIdentity);
  }

  async function abortExternalRestart() {
    if (!enabled) return null;
    const nextIdentity = identity || await resolveIdentity();
    const stored = await attachStoredEndpoint(nextIdentity);
    if (stored) {
      return startRefresh(nextIdentity, stored);
    }
    const processes = await listProcesses(nextIdentity).catch(() => []);
    beginRestartWait(nextIdentity, processes);
    publish({ status: "restart-required", restartRequired: true, error: null });
    return null;
  }

  const setEnabledNow = async next => {
    if (platform !== "win32") {
      if (next) throw new Error("Codex Wallpapers official-app integration is currently available on Windows only");
      enabled = false;
      stopRestartWait();
      stopRefresh();
      publish({ status: "disabled", restartRequired: false, error: null });
      return { enabled: false, restartRequired: false, applied: 0 };
    }
    if (!next) {
      enabled = false;
      stopRestartWait();
      const activeSessions = [...sessions.values()];
      if (activeSessions.length === 0) {
        try {
          const nextIdentity = identity || await resolveIdentity();
          const stored = await attachStoredEndpoint(nextIdentity);
          if (stored) {
            const targets = await discoverTargets(stored);
            for (const target of targets) {
              const contents = new CdpContents(target.webSocketUrl, WebSocketImpl);
              sessions.set(target.id, { contents, generation: null });
            }
          }
        } catch {}
      }
      await Promise.all([...sessions.values()].map(entry => wallpaperManager.dispose(entry.contents).catch(error => {
        logger.warn("wallpapers.official_codex_dispose_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })));
      stopRefresh();
      publish({ status: "disabled", restartRequired: false, error: null });
      return { enabled: false, restartRequired: false, applied: 0, status, error: lastError };
    }

    enabled = true;
    publish({ status: "starting", restartRequired: false, error: null });
    await wallpaperManager.checkLibrary();
    identity = await resolveIdentity();
    const stored = await attachStoredEndpoint(identity);
    if (stored) {
      publish({ status: "attaching" });
      const applied = await startRefresh(identity, stored);
      return { enabled: true, restartRequired: false, applied, status, error: lastError };
    }
    const processes = await listProcesses(identity);
    if (processes.length > 0) {
      beginRestartWait(identity, processes);
      publish({ status: "restart-required", restartRequired: true, error: null });
      return { enabled: true, restartRequired: true, applied: 0, status, error: lastError };
    }
    publish({ status: "launching" });
    return launchAndAttach(identity);
  };

  return {
    setEnabled(next) {
      const requested = next === true;
      operation = operation.catch(() => {}).then(() => setEnabledNow(requested)).catch(error => {
        publish({
          status: "error",
          restartRequired: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
      return operation;
    },
    destroy() {
      stopRestartWait();
      stopRefresh();
    },
    prepareExternalRestart,
    resumeExternalRestart,
    abortExternalRestart,
    endpointPath,
    dataRoot: resolvedDataRoot,
  };
}

module.exports = {
  CdpContents,
  ENDPOINT_CONNECT_TIMEOUT_MS,
  RATE_LIMIT_GATE_PROBE_SCRIPT,
  RATE_LIMIT_GATE_RECOVERY_SCRIPT,
  RATE_LIMIT_RECOVERY_COOLDOWN_MS,
  RATE_LIMIT_STALE_CONFIRM_MS,
  RATE_LIMIT_USAGE_RECHECK_MS,
  RESTART_POLL_INTERVAL_MS,
  TARGET_REFRESH_INTERVAL_MS,
  browserIdFromVersionPayload,
  createOfficialCodexWallpaperController,
  discoverOfficialTargets,
  endpointRecordLooksValid,
  findLoopbackPort,
  launchOfficialCodex,
  launchOfficialCodexApplication,
  listOfficialCodexProcesses,
  officialAppTarget,
  providerAwareRateLimitGateScript,
  resolveOfficialCodexIdentity,
  usageAllowsRateLimitRecovery,
  usageShowsNativeQuotaExhaustion,
  validateOfficialEndpoint,
  waitForOfficialEndpoint,
};
