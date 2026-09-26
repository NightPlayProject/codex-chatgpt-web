import languages from "../electron/languages.json";
import type { LimitsSnapshot } from "./limits-types";

export type Language = keyof typeof languages;
export type LauncherProfile = "production" | "development";
export type BrowserInteractionMode = "automatic" | "manual";
export type Surface = "browser" | "setup" | "mcp" | "activity" | "limits" | "accounts" | "settings";

export interface LauncherState {
  version: 1;
  language: Language | null;
  onboardingComplete: boolean;
  githubOpened: boolean;
  xOpened: boolean;
  autoStart: boolean;
  keepRunningOnClose: boolean;
  showBrowserDuringTurns: boolean;
  saveChats: boolean;
  savedChats: Array<{ url: string; title: string; conversationKey: string | null; updatedAt: string }>;
  browserInteractionMode: BrowserInteractionMode;
  experimentalBiggerContext: boolean;
  experimentalSkillAttachments: boolean;
  experimentalFreshConversationPerTurn: boolean;
  useSavedChats: boolean;
  zeroRiskProEnabled: boolean;
  codexWallpapersEnabled: boolean;
  codexWallpapersRestartRequired: boolean;
  codexWallpapersStatus: string | null;
  codexWallpapersError: string | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  browserSmokePassed?: boolean;
  browserSmokeVersion?: string | null;
  coreSetupComplete?: boolean;
  codexCatalogVerified?: boolean;
  mcpSetupComplete?: boolean;
  mcpRuntimeInstalled?: boolean;
  codexRestartRequired?: boolean;
  mcpGuideStep: number;
  sessionRefreshReminderAt: string | null;
}

export interface BrowserState {
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error";
  message: string;
  url: string;
  title: string;
  authenticated: boolean;
  visible: boolean;
  surfaceActive: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  activeTabId: string;
  maxTabs: number;
  tabs: BrowserTabState[];
}

export interface BrowserTabState {
  id: string;
  traceId: string | null;
  title: string;
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error" | "aborted";
  loading: boolean;
  active: boolean;
  closable: boolean;
  interactionMode?: BrowserInteractionMode;
  manualState?: "awaiting-user" | "sent" | "running" | "completed" | "timed-out" | "cancelled" | "failed";
  manualDeadlineAt?: string;
  canCopyPrompt?: boolean;
  canConfirmSent?: boolean;
}

export interface LogRecord {
  at: string;
  level: "debug" | "info" | "warning" | "error";
  event: string;
  detail: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
  nextStep?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: "browser-only" | "full";
  checks: DoctorCheck[];
}

export interface OperationState {
  name: string;
  status: "running" | "completed" | "failed";
  message: string;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  | { status: "available" | "downloading" | "installing"; version: string }
  | { status: "error"; message: string };

export interface LauncherSnapshot {
  profile: LauncherProfile;
  profilePaths: {
    coreHome: string;
    codexHome: string;
    userData: string;
  };
  state: LauncherState;
  browser: BrowserState | null;
  connectorName: string;
  connectorNames: Record<BrowserInteractionMode, string>;
  mcpCredentialsConfigured: boolean;
  logs: LogRecord[];
  urls: {
    github: string;
    x: string;
    connectors: string;
    tunnels: string;
    keys: string;
    codexSwitcher: string;
  };
  platform: string;
  packaged: boolean;
  version: string;
  smokePassed: boolean;
  operation: OperationState | null;
  update: UpdateState;
  accounts: AccountSwitcherSnapshot;
}

export type AccountHealth = "active" | "ready" | "expired" | "unavailable";

export interface CodexAccountSummary {
  id: string;
  shortId: string | null;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  plan: string | null;
  authMode: "chatgpt" | "api-key" | "unknown";
  accountId: string | null;
  isActive: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  subscriptionExpiresAt: string | null;
  usage: AccountUsageSnapshot | null;
  stats: AccountUsageStats | null;
  status: AccountHealth;
}

export interface AccountUsageSnapshot {
  available: boolean;
  fetchedAt: string | null;
  primaryUsedPercent: number | null;
  primaryWindowMinutes: number | null;
  primaryResetsAt: string | null;
  secondaryUsedPercent: number | null;
  secondaryWindowMinutes: number | null;
  secondaryResetsAt: string | null;
  hasCredits: boolean | null;
  unlimitedCredits: boolean | null;
  creditsBalance: string | null;
  error: string | null;
}

export interface AccountUsageStats {
  available: boolean;
  fetchedAt: string | null;
  generatedAt: string | null;
  statsAsOf: string | null;
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestTaskSeconds: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  fastModePercent: number | null;
  reasoningEffort: string | null;
  reasoningEffortPercent: number | null;
  skillsExplored: number | null;
  totalSkillsUsed: number | null;
  totalThreads: number | null;
  resetCreditsAvailable: number | null;
  resetCreditsNextExpiresAt: string | null;
  daily: Array<{ date: string; tokens: number }>;
  error: string | null;
}

export interface AccountActivityEvent {
  at: string;
  accountId: string;
  accountName: string;
  kind: "switch" | "import";
}

export interface AccountActivitySummary {
  totalSwitches: number;
  switchesToday: number;
  activeDays: number;
  lastSwitchAt: string | null;
  daily: Array<{ date: string; count: number }>;
  recent: AccountActivityEvent[];
}

export interface OfficialCodexAppState {
  supported: boolean;
  installed: boolean;
  running: boolean;
  processCount: number;
  version: string | null;
  canSwitch: boolean;
  message: string;
}

export interface AccountCurrentSession {
  present: boolean;
  managed: boolean;
  email: string | null;
  plan: string | null;
  authMode: "chatgpt" | "api-key" | null;
}

export interface AccountSwitcherSnapshot {
  supported: boolean;
  configured: boolean;
  source: "codex-switcher" | "official-codex";
  storePath: string;
  activeAccountId: string | null;
  accounts: CodexAccountSummary[];
  currentSession: AccountCurrentSession;
  officialApp: OfficialCodexAppState;
  activity: AccountActivitySummary;
}

export interface LauncherApi {
  snapshot(): Promise<LauncherSnapshot>;
  getLimits(): Promise<LimitsSnapshot>;
  setupLimits(): Promise<LimitsSnapshot>;
  setLanguage(language: Language): Promise<LauncherState>;
  openSocial(target: "github" | "x"): Promise<LauncherState>;
  completeOnboarding(language: Language, browserInteractionMode: BrowserInteractionMode): Promise<LauncherState>;
  openExternal(url: string): Promise<boolean>;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  setBrowserSurfaceActive(active: boolean): Promise<BrowserState>;
  showBrowser(): Promise<BrowserState>;
  hideBrowser(): Promise<BrowserState>;
  navigateBrowser(action: "back" | "forward" | "reload"): Promise<BrowserState>;
  zoomBrowser(action: "in" | "out" | "reset"): Promise<BrowserState>;
  selectBrowserTab(tabId: string): Promise<BrowserState>;
  closeBrowserTab(tabId: string): Promise<BrowserState>;
  copyManualPrompt(tabId: string): Promise<BrowserState>;
  confirmManualSent(tabId: string): Promise<BrowserState>;
  openLogin(): Promise<BrowserState>;
  openPasskeyLogin(): Promise<BrowserState>;
  continuePasskeyLogin(): Promise<boolean>;
  logoutChatGpt(): Promise<{ browser: BrowserState; state: LauncherState }>;
  dismissSessionReminder(): Promise<LauncherState>;
  smokeTest(): Promise<{ ok: boolean; effort: string; response: string }>;
  verifyMcp(): Promise<DoctorReport>;
  doctor(): Promise<DoctorReport>;
  cancelTurns(): Promise<{ stdout: string }>;
  uninstallIntegration(): Promise<{ cancelled: true } | { cancelled: false; state: LauncherState }>;
  setupCore(): Promise<{ ok: boolean; stdout: string; restartRequired: boolean }>;
  setupMcp(input: {
    tunnelId?: string;
    runtimeKey?: string;
    replace?: boolean;
    interactionMode?: BrowserInteractionMode;
  }): Promise<{ ok: boolean; stdout: string }>;
  setupNativeComputerUse(): Promise<{
    ok: boolean;
    registered: boolean;
    restartRequired: boolean;
    stdout: string;
  }>;
  setMcpStep(step: number): Promise<LauncherState>;
  setAutostart(enabled: boolean): Promise<{ state: LauncherState; supported: boolean; enabled: boolean }>;
  setBiggerContext(enabled: boolean): Promise<LauncherState>;
  setSkillAttachments(enabled: boolean): Promise<LauncherState>;
  setFreshConversationPerTurn(enabled: boolean): Promise<LauncherState>;
  setUseSavedChats(enabled: boolean): Promise<LauncherState>;
  setZeroRiskPro(enabled: boolean): Promise<LauncherState>;
  setWallpapersEnabled(enabled: boolean): Promise<LauncherState>;
  accounts(options?: { refreshUsage?: boolean }): Promise<AccountSwitcherSnapshot>;
  addAccount(): Promise<AccountSwitcherSnapshot | null>;
  addCurrentAccount(): Promise<AccountSwitcherSnapshot>;
  startAccountLogin(accountName?: string): Promise<{ authUrl: string; callbackPort: number }>;
  completeAccountLogin(): Promise<AccountSwitcherSnapshot>;
  cancelAccountLogin(): Promise<boolean>;
  switchAccount(accountId: string): Promise<AccountSwitcherSnapshot>;
  removeAccount(accountId: string): Promise<AccountSwitcherSnapshot>;
  setBrowserInteractionMode(mode: BrowserInteractionMode): Promise<{
    state: LauncherState;
    credentialsRequired: boolean;
    targetMode: BrowserInteractionMode;
  }>;
  setPreference(
    key: "keepRunningOnClose" | "showBrowserDuringTurns" | "saveChats",
    value: boolean,
  ): Promise<LauncherState>;
  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;
  logs(limit?: number): Promise<LogRecord[]>;
  exportLogs(): Promise<string | null>;
  installUpdate(): Promise<boolean>;
  windowState(): Promise<{ fullScreen: boolean; maximized: boolean }>;
  windowControl(action: "close" | "minimize" | "zoom"): void;
  onWindowStateChanged(listener: (state: { fullScreen: boolean; maximized: boolean }) => void): () => void;
  onStateChanged(listener: (state: LauncherState) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onOperation(listener: (state: OperationState) => void): () => void;
  onAccountsState(listener: (state: AccountSwitcherSnapshot) => void): () => void;
  onLog(listener: (record: LogRecord) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
