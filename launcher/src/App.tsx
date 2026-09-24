import languages from "../electron/languages.json";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { formatAccountDisplayName, formatAccountEmail } from "./account-display";
import { copyFor, localizeRuntimeMessage, type Copy } from "./i18n";
import { Icon, type IconName } from "./icons";
import { LimitsSurface } from "./LimitsSurface";
import { limitsCopyFor } from "./limits-copy";
import { useLimits } from "./useLimits";
import type {
  BrowserInteractionMode,
  BrowserState,
  AccountUsageSnapshot,
  AccountUsageStats,
  AccountSwitcherSnapshot,
  CodexAccountSummary,
  DoctorReport,
  Language,
  LauncherSnapshot,
  LauncherState,
  LogRecord,
  OperationState,
  Surface,
} from "./types";

const api = window.codexWebLauncher;
const PANEL_TRANSITION = { duration: 0.3, ease: [0.16, 1, 0.3, 1] } as const;
const COMPACT_SIDEBAR_QUERY = "(max-width: 820px)";
const MCP_GUIDE_MEDIA = [
  new URL("./assets/mcp-create-tunnel.mp4", import.meta.url).href,
  new URL("./assets/mcp-connect-connector.mp4", import.meta.url).href,
  new URL("./assets/mcp-connect-connector.mp4", import.meta.url).href,
] as const;

export function App() {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const documentLanguage = snapshot?.state.language ?? "en";

  useEffect(() => {
    document.documentElement.lang = documentLanguage;
  }, [documentLanguage]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    let latestUpdate: LauncherSnapshot["update"] | null = null;
    const unsubscribeState = api.onStateChanged((state) => {
      setSnapshot((current) => current
        ? {
            ...current,
            state,
            smokePassed: current.smokePassed
              || (state.browserSmokePassed === true && state.browserSmokeVersion === current.version),
          }
        : current);
    });
    const unsubscribeBrowser = api.onBrowserState(setBrowser);
    const unsubscribeOperation = api.onOperation((next) => {
      setOperation(next);
      if (next.status === "failed" && next.name !== "mcp-verification") setError(next.message);
    });
    const unsubscribeLog = api.onLog((record) => setLogs((current) => [...current.slice(-299), record]));
    const unsubscribeUpdate = api.onUpdateState((update) => {
      latestUpdate = update;
      setSnapshot((current) => current ? { ...current, update } : current);
    });
    void api.snapshot().then((next) => {
      if (cancelled) return;
      setSnapshot({ ...next, update: latestUpdate ?? next.update });
      setBrowser(next.browser);
      setLogs(next.logs);
      setOperation(next.operation);
      if (next.operation?.status === "failed" && next.operation.name !== "mcp-verification") {
        setError(next.operation.message);
      }
    }).catch((cause) => {
      if (!cancelled) setError(messageOf(cause));
    });
    return () => {
      cancelled = true;
      unsubscribeState();
      unsubscribeBrowser();
      unsubscribeOperation();
      unsubscribeLog();
      unsubscribeUpdate();
    };
  }, []);

  const updateState = useCallback((state: LauncherState) => {
    setSnapshot((current) => current
      ? {
          ...current,
          state,
          smokePassed: current.smokePassed
            || (state.browserSmokePassed === true && state.browserSmokeVersion === current.version),
        }
      : current);
  }, []);

  if (!api) return <FatalMessage message="Launcher IPC is unavailable." />;
  if (!snapshot) return <LaunchLoading />;

  const language = snapshot.state.language ?? "en";
  const copy = copyFor(language);

  return (
    <div
      className="app-root"
      data-language={language}
      data-platform={snapshot.platform}
      data-profile={snapshot.profile}
      data-theme="dark"
    >
      <AnimatePresence mode="wait">
        {!snapshot.state.onboardingComplete ? (
          <Onboarding
            key="onboarding"
            language={language}
            setError={setError}
            snapshot={snapshot}
            updateState={updateState}
          />
        ) : (
          <LauncherShell
            browser={browser}
            copy={copy}
            key="launcher"
            language={language}
            logs={logs}
            operation={operation}
            setError={setError}
            snapshot={snapshot}
            updateState={updateState}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {error ? <ErrorToast copy={copy} message={error} onDismiss={() => setError(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

function Onboarding({
  language,
  setError,
  snapshot,
  updateState,
}: {
  language: Language;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [stage, setStage] = useState<"language" | "interaction" | "support">(
    snapshot.state.language ? "interaction" : "language",
  );
  const [selectedLanguage, setSelectedLanguage] = useState<Language>(language);
  const [selectedInteractionMode, setSelectedInteractionMode] = useState<BrowserInteractionMode>(
    snapshot.state.browserInteractionMode,
  );
  const [busy, setBusy] = useState(false);
  const localized = copyFor(selectedLanguage);
  const isLanguage = stage === "language";
  const isInteraction = stage === "interaction";
  const stageIndex = isLanguage ? 0 : isInteraction ? 1 : 2;

  const chooseLanguage = async () => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setLanguage(selectedLanguage));
      setStage("interaction");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const openSocial = async (target: "github" | "x") => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.openSocial(target));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.completeOnboarding(selectedLanguage, selectedInteractionMode));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.main
      animate={{ opacity: 1 }}
      className="welcome"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      <header className="welcome-top draggable">
        <div className="welcome-brand no-drag">
          <BrandMark small />
          <span>{localized.product}</span>
          {snapshot.profile === "development" ? <em className="dev-profile-badge">{localized.devBadge}</em> : null}
        </div>
        <span className="welcome-version no-drag">v{snapshot.version}</span>
      </header>

      <AnimatePresence mode="wait">
        <motion.section
          animate={{ opacity: 1, y: 0 }}
          className="welcome-stage"
          exit={{ opacity: 0, y: -8 }}
          initial={{ opacity: 0, y: 8 }}
          key={stage}
          transition={PANEL_TRANSITION}
        >
          <span className="welcome-kicker">0{stageIndex + 1}</span>
          <h1>{isLanguage
            ? localized.chooseLanguage
            : isInteraction ? localized.interactionMode : localized.supportTitle}</h1>
          <p>{isLanguage
            ? localized.chooseLanguageHint
            : isInteraction ? localized.interactionModeOnboardingBody : localized.supportBody}</p>

          {isLanguage ? (
            <div className="welcome-options" role="radiogroup" aria-label={localized.chooseLanguage}>
              {languageOptions.map(option => (
                <WelcomeOption
                  key={option.value}
                  active={selectedLanguage === option.value}
                  detail={option.label}
                  label={option.label}
                  marker={option.marker}
                  onClick={() => setSelectedLanguage(option.value)}
                />
              ))}
            </div>
          ) : isInteraction ? (
            <InteractionModePicker
              className="welcome-interaction-mode-picker"
              copy={localized}
              disabled={busy}
              mode={selectedInteractionMode}
              onChange={setSelectedInteractionMode}
            />
          ) : (
            <div className="welcome-options">
              <WelcomeAction
                complete={snapshot.state.githubOpened}
                disabled={busy}
                icon="github"
                label={snapshot.state.githubOpened ? localized.starred : localized.star}
                onClick={() => openSocial("github")}
              />
              <WelcomeAction
                complete={snapshot.state.xOpened}
                disabled={busy}
                icon="x"
                label={snapshot.state.xOpened ? localized.followed : localized.follow}
                onClick={() => openSocial("x")}
              />
            </div>
          )}
        </motion.section>
      </AnimatePresence>

      <footer className="welcome-footer">
        <div>
          {!isLanguage ? (
            <button
              className="text-button"
              onClick={() => setStage(isInteraction ? "language" : "interaction")}
              type="button"
            >
              {localized.previous}
            </button>
          ) : null}
        </div>
        <div className="welcome-progress" aria-label={`${stageIndex + 1} / 3`}>
          {[0, 1, 2].map(index => (
            <span
              className={index < stageIndex ? "is-complete" : index === stageIndex ? "is-active" : ""}
              key={index}
            />
          ))}
        </div>
        <PrimaryButton
          disabled={busy || (stage === "support" && (!snapshot.state.githubOpened || !snapshot.state.xOpened))}
          onClick={isLanguage
            ? chooseLanguage
            : isInteraction ? () => setStage("support") : finish}
        >
          {stage === "support" ? localized.finishWelcome : localized.continue}
        </PrimaryButton>
      </footer>
    </motion.main>
  );
}

function LauncherShell({
  browser,
  copy,
  language,
  logs,
  operation,
  setError,
  snapshot,
  updateState,
}: {
  browser: BrowserState | null;
  copy: Copy;
  language: Language;
  logs: LogRecord[];
  operation: OperationState | null;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const interactionSetupComplete = snapshot.state.coreSetupComplete === true
    && (snapshot.state.browserInteractionMode === "manual"
      || snapshot.state.codexCatalogVerified === true);
  const firstRunZeroRiskSetup = snapshot.state.browserInteractionMode === "manual"
    && snapshot.state.coreSetupComplete !== true;
  const [surface, setSurface] = useState<Surface>(
    firstRunZeroRiskSetup ? "mcp" : interactionSetupComplete ? "browser" : "setup",
  );
  const devProfile = snapshot.profile === "development";
  const compactAtMount = useRef(window.matchMedia(COMPACT_SIDEBAR_QUERY).matches).current;
  const [sidebarOpen, setSidebarOpen] = useState(!compactAtMount);
  const [compactSidebar, setCompactSidebar] = useState(compactAtMount);
  const [browserSlot, setBrowserSlot] = useState<HTMLDivElement | null>(null);
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSwitcherSnapshot>(snapshot.accounts);
  const [sessionReminderBusy, setSessionReminderBusy] = useState(false);
  const [sessionReminderDue, setSessionReminderDue] = useState(false);
  const [mcpTargetMode, setMcpTargetMode] = useState<BrowserInteractionMode | null>(null);
  const [biggerContextRecommendationOpen, setBiggerContextRecommendationOpen] = useState(
    snapshot.state.browserInteractionMode === "automatic"
      && snapshot.state.coreSetupComplete === true
      && !snapshot.state.experimentalBiggerContext,
  );
  const [biggerContextRecommendationBusy, setBiggerContextRecommendationBusy] = useState(false);
  const browserSlotRef = useCallback((node: HTMLDivElement | null) => setBrowserSlot(node), []);
  const browserSurfaceActive = surface === "browser"
    && !(compactSidebar && sidebarOpen)
    && !biggerContextRecommendationOpen;
  const needsBrowser = snapshot.state.browserInteractionMode === "automatic"
    && browser?.authenticated !== true;
  const needsSetup = !needsBrowser && !interactionSetupComplete;
  const mcpOptional = snapshot.state.browserInteractionMode === "automatic"
    && snapshot.state.codexCatalogVerified === true
    && snapshot.state.mcpSetupComplete !== true;
  const updateVisible = ["available", "downloading", "installing"].includes(snapshot.update.status);
  const updateBusy = snapshot.update.status === "downloading" || snapshot.update.status === "installing";
  const updateVersion = "version" in snapshot.update ? snapshot.update.version : null;
  const selectedManualTab = browser?.tabs.find(tab => tab.active && tab.interactionMode === "manual");
  const limits = useLimits(api!, snapshot.state.browserInteractionMode === "manual");
  const limitsCopy = limitsCopyFor(language);

  useEffect(() => {
    const unsubscribe = api!.onAccountsState(setAccountSnapshot);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (surface !== "accounts") return;
    let cancelled = false;
    const refresh = (refreshUsage = false) => {
      void api!.accounts({ refreshUsage }).then(next => {
        if (!cancelled) setAccountSnapshot(next);
      }).catch((cause) => {
        if (!cancelled) setError(messageOf(cause));
      });
    };
    refresh(true);
    const timer = window.setInterval(() => refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setError, surface]);

  useEffect(() => {
    if (snapshot.state.browserInteractionMode === "manual") {
      setBiggerContextRecommendationOpen(false);
    }
  }, [snapshot.state.browserInteractionMode]);

  useEffect(() => {
    if (!selectedManualTab) return;
    setSurface("browser");
    setSidebarOpen(false);
    setBiggerContextRecommendationOpen(false);
    void api!.setBrowserSurfaceActive(true).catch((cause) => setError(messageOf(cause)));
  }, [selectedManualTab?.id, selectedManualTab?.manualState, setError]);

  useLayoutEffect(() => {
    let cancelled = false;
    let animationFrame = 0;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      if (!browserSlot) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const rect = browserSlot.getBoundingClientRect();
        void api!.setBrowserBounds({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }).catch((cause) => setError(messageOf(cause)));
      });
    };

    void api!.setBrowserSurfaceActive(browserSurfaceActive).then(() => {
      if (cancelled || !browserSurfaceActive || !browserSlot) return;
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(browserSlot);
      window.addEventListener("resize", measure);
    }).catch((cause) => setError(messageOf(cause)));

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [browserSlot, browserSurfaceActive, setError]);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_SIDEBAR_QUERY);
    const apply = () => {
      setCompactSidebar(media.matches);
      setSidebarOpen(!media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const reminderAt = snapshot.state.sessionRefreshReminderAt;
    const reminderTime = reminderAt === null ? Number.NaN : Date.parse(reminderAt);
    if (browser?.authenticated !== true || !Number.isFinite(reminderTime)) {
      setSessionReminderDue(false);
      return;
    }
    const delay = reminderTime - Date.now();
    if (delay <= 0) {
      setSessionReminderDue(true);
      return;
    }
    setSessionReminderDue(false);
    const timer = window.setTimeout(() => setSessionReminderDue(true), delay);
    return () => window.clearTimeout(timer);
  }, [browser?.authenticated, snapshot.state.sessionRefreshReminderAt]);

  const activateBrowser = useCallback(async (show = false) => {
    setSurface("browser");
    await api!.setBrowserSurfaceActive(true);
    if (show) await api!.showBrowser();
  }, []);

  const toggleSidebar = () => {
    const next = !sidebarOpen;
    if (compactSidebar && next && surface === "browser") {
      void api!.setBrowserSurfaceActive(false)
        .then(() => setSidebarOpen(true))
        .catch((cause) => setError(messageOf(cause)));
      return;
    }
    setSidebarOpen(next);
  };

  const navigateSurface = (next: Surface) => {
    setSurface(next);
    if (compactSidebar) setSidebarOpen(false);
  };

  const installUpdate = async () => {
    setError(null);
    try {
      await api!.installUpdate();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const dismissSessionReminder = async () => {
    if (sessionReminderBusy) return;
    setSessionReminderBusy(true);
    setError(null);
    try {
      updateState(await api!.dismissSessionReminder());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSessionReminderBusy(false);
    }
  };

  const logoutChatGpt = async () => {
    if (sessionReminderBusy) return;
    setSessionReminderBusy(true);
    setError(null);
    try {
      const result = await api!.logoutChatGpt();
      updateState(result.state);
      navigateSurface("browser");
      await api!.setBrowserSurfaceActive(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSessionReminderBusy(false);
    }
  };

  const setRecommendedBiggerContext = async (enabled: boolean) => {
    if (biggerContextRecommendationBusy) return;
    setBiggerContextRecommendationBusy(true);
    setError(null);
    try {
      updateState(await api!.setBiggerContext(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBiggerContextRecommendationBusy(false);
    }
  };

  return (
    <motion.main
      animate={{ opacity: 1 }}
      className={`app-shell${compactSidebar ? " is-compact" : ""}${sidebarOpen ? " is-sidebar-open" : ""}`}
      initial={{ opacity: 0 }}
    >
      <TitleBar
        copy={copy}
        devProfile={devProfile}
        draggable={surface !== "browser"}
        sidebarOpen={sidebarOpen}
        toggleSidebar={toggleSidebar}
      />

      {compactSidebar && sidebarOpen ? (
        <button
          aria-label={copy.hideSidebar}
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      ) : null}

      <motion.aside
        animate={{ width: sidebarOpen ? "var(--sidebar-width)" : 0 }}
        className="app-sidebar"
        initial={false}
        transition={{ type: "spring", duration: 0.5, bounce: 0.08 }}
      >
        <div className="sidebar-clip">
          <div className="sidebar-content">
            <div className="sidebar-brand-row">
              <div className="sidebar-brand-identity">
                <BrandMark small />
                <strong>{copy.product}</strong>
                {devProfile ? <em className="dev-profile-badge">{copy.devBadge}</em> : null}
              </div>
              <div className="sidebar-brand-actions">
                <IconButton
                  icon="github"
                  label="GitHub"
                  onClick={() => void api!.openExternal(snapshot.urls.github).catch((cause) => setError(messageOf(cause)))}
                />
                <IconButton
                  icon="x"
                  label="X"
                  onClick={() => void api!.openExternal(snapshot.urls.x).catch((cause) => setError(messageOf(cause)))}
                />
              </div>
            </div>

            <nav className="sidebar-nav" aria-label={copy.workspace}>
              <SidebarGroup label={copy.workspace}>
                <SidebarItem
                  active={surface === "browser"}
                  badge={needsBrowser
                    ? <ActionDot pulse tone="required" />
                    : browser?.status === "error"
                      ? <ActionDot tone="error" />
                      : null}
                  icon="browser"
                  label={copy.browser}
                  onClick={() => navigateSurface("browser")}
                />
              </SidebarGroup>
              <SidebarGroup label={copy.configuration}>
                <SidebarItem
                  active={surface === "setup"}
                  badge={needsSetup ? <ActionDot pulse tone="required" /> : null}
                  icon="setup"
                  label={copy.setup}
                  onClick={() => navigateSurface("setup")}
                />
                <SidebarItem
                  active={surface === "mcp"}
                  badge={mcpOptional ? <ActionDot tone="optional" /> : null}
                  icon="mcp"
                  label="MCP"
                  onClick={() => {
                    setMcpTargetMode(null);
                    navigateSurface("mcp");
                  }}
                />
              </SidebarGroup>
              <SidebarGroup label={copy.runtime}>
                <SidebarItem active={surface === "activity"} icon="activity" label={copy.activity} onClick={() => navigateSurface("activity")} />
                <SidebarItem
                  active={surface === "limits"}
                  badge={limits.needsAttention ? (
                    <span role="img" aria-label={limitsCopy.nearLimit} title={limitsCopy.nearLimit}>
                      <ActionDot tone="optional" />
                    </span>
                  ) : null}
                  icon="logs"
                  label={limitsCopy.title}
                  onClick={() => navigateSurface("limits")}
                />
              </SidebarGroup>
            </nav>

            <div className="sidebar-footer">
              {updateVisible ? (
                <SidebarItem
                  active={false}
                  disabled={updateBusy || operation?.status === "running" || browser?.status === "running"}
                  icon="update"
                  label={updateBusy ? copy.updating : `${copy.updateAvailable} v${updateVersion}`}
                  onClick={() => void installUpdate()}
                  tone="update"
                />
              ) : null}
              <SidebarItem
                active={surface === "accounts"}
                icon="accounts"
                label={copy.accountSwitcher}
                onClick={() => navigateSurface("accounts")}
              />
              <SidebarItem
                active={surface === "settings"}
                icon="settings"
                label={copy.settings}
                onClick={() => navigateSurface("settings")}
              />
            </div>
          </div>
        </div>
      </motion.aside>

      <section className="workspace">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            animate={{ opacity: 1 }}
            className="surface-transition"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key={surface}
            transition={{ duration: 0.16 }}
          >
            {surface === "browser" ? (
              <BrowserSurface
                browser={browser}
                browserSlotRef={browserSlotRef}
                copy={copy}
                interactionMode={snapshot.state.browserInteractionMode}
                operation={operation}
                platform={snapshot.platform}
                setError={setError}
              />
            ) : null}
            {surface === "setup" ? (
              <SetupSurface
                activateBrowser={activateBrowser}
                browser={browser}
                copy={copy}
                devProfile={devProfile}
                operation={operation}
                setError={setError}
                showMcp={() => {
                  setMcpTargetMode(null);
                  setSurface("mcp");
                }}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "mcp" ? (
              <McpSurface
                copy={copy}
                devProfile={devProfile}
                interactionMode={mcpTargetMode ?? snapshot.state.browserInteractionMode}
                language={language}
                onDone={() => {
                  setMcpTargetMode(null);
                  setSurface("browser");
                }}
                operation={operation}
                platform={snapshot.platform}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "activity" ? (
              <ActivitySurface copy={copy} language={language} logs={logs} setError={setError} />
            ) : null}
            {surface === "limits" ? (
              <LimitsSurface
                api={api!}
                tracker={limits}
                language={language}
                manualMode={snapshot.state.browserInteractionMode === "manual"}
                runtimeBusy={operation?.status === "running"
                  || browser?.status === "running" || browser?.status === "testing" || browser?.status === "loading"
                  || browser?.loading === true
                  || browser?.tabs.some((tab) => tab.status === "running" || tab.status === "testing" || tab.loading) === true}
                setError={setError}
              />
            ) : null}
            {surface === "accounts" ? (
              <AccountSwitcherSurface
                copy={copy}
                language={language}
                setError={setError}
                setSnapshot={setAccountSnapshot}
                snapshot={accountSnapshot}
              />
            ) : null}
            {surface === "settings" ? (
              <SettingsSurface
                configureInteractionMode={(mode) => {
                  setMcpTargetMode(mode);
                  setSurface("mcp");
                }}
                copy={copy}
                devProfile={devProfile}
                language={language}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </section>

      <AnimatePresence>
        {biggerContextRecommendationOpen ? (
          <BiggerContextRecommendation
            busy={biggerContextRecommendationBusy || operation?.status === "running"}
            checked={snapshot.state.experimentalBiggerContext}
            copy={copy}
            onChange={(enabled) => void setRecommendedBiggerContext(enabled)}
            onClose={() => setBiggerContextRecommendationOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {sessionReminderDue && !biggerContextRecommendationOpen ? (
          <SessionRefreshReminder
            busy={sessionReminderBusy}
            copy={copy}
            onDismiss={() => void dismissSessionReminder()}
            onLogout={() => void logoutChatGpt()}
          />
        ) : null}
      </AnimatePresence>
    </motion.main>
  );
}

function TitleBar({
  copy,
  devProfile,
  draggable,
  sidebarOpen,
  toggleSidebar,
}: {
  copy: Copy;
  devProfile: boolean;
  draggable: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}) {
  return (
    <header className={`app-titlebar${draggable ? " draggable" : ""}`}>
      <div className="titlebar-left no-drag">
        <IconButton
          icon="sidebar"
          label={sidebarOpen ? copy.hideSidebar : copy.showSidebar}
          onClick={toggleSidebar}
        />
        {devProfile ? <span className="titlebar-dev-profile">{copy.devBadge}</span> : null}
      </div>
    </header>
  );
}

function SidebarGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="sidebar-group">
      <h2>{label}</h2>
      <div>{children}</div>
    </section>
  );
}

function SidebarItem({
  active,
  badge,
  disabled = false,
  icon,
  label,
  onClick,
  tone,
}: {
  active: boolean;
  badge?: ReactNode;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
  tone?: "update";
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`sidebar-item${active ? " is-active" : ""}${tone === "update" ? " is-update" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon === "mcp" ? <McpMark /> : <Icon name={icon} />}
      <span>{label}</span>
      {badge ? <i className="sidebar-item-badge">{badge}</i> : null}
    </button>
  );
}

function BrowserSurface({
  browser,
  browserSlotRef,
  copy,
  interactionMode,
  operation,
  platform,
  setError,
}: {
  browser: BrowserState | null;
  browserSlotRef: (node: HTMLDivElement | null) => void;
  copy: Copy;
  interactionMode: BrowserInteractionMode;
  operation: OperationState | null;
  platform: string;
  setError: (error: string | null) => void;
}) {
  const [passkeyContinuationRequested, setPasskeyContinuationRequested] = useState(false);
  const visible = browser?.visible === true;
  const manualInteraction = interactionMode === "manual";
  const passkeyAvailable = !manualInteraction
    && platform === "darwin"
    && browser?.authenticated !== true;
  const selectedManualTab = browser?.tabs.find(tab => tab.active && tab.interactionMode === "manual");
  const navigationLocked = browser?.status === "running" || browser?.status === "testing";
  const passkeyWaiting = passkeyAvailable
    && operation?.name === "passkey-login"
    && operation.status === "running"
    && browser?.authenticated !== true;
  useEffect(() => {
    if (!passkeyWaiting) setPasskeyContinuationRequested(false);
  }, [passkeyWaiting]);
  const navigate = async (action: "back" | "forward" | "reload") => {
    try {
      await api!.navigateBrowser(action);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const zoom = async (action: "in" | "out" | "reset") => {
    try {
      await api!.zoomBrowser(action);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const toggle = async () => {
    try {
      if (visible) await api!.hideBrowser();
      else await api!.showBrowser();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const selectTab = async (tabId: string) => {
    try {
      await api!.selectBrowserTab(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const closeTab = async (tabId: string) => {
    try {
      await api!.closeBrowserTab(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const openPasskeyLogin = () => {
    if (operation?.status === "running") return;
    setError(null);
    void api!.openPasskeyLogin().catch(cause => setError(messageOf(cause)));
  };
  const continuePasskeyLogin = async () => {
    if (!passkeyWaiting || passkeyContinuationRequested) return;
    setPasskeyContinuationRequested(true);
    setError(null);
    try {
      await api!.continuePasskeyLogin();
    } catch (cause) {
      setPasskeyContinuationRequested(false);
      setError(messageOf(cause));
    }
  };
  const copyManualPrompt = async (tabId: string) => {
    try {
      await api!.copyManualPrompt(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const confirmManualSent = async (tabId: string) => {
    try {
      await api!.confirmManualSent(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <section className="browser-surface">
      <div className="browser-tab-strip" title={copy.browserTabLimit}>
        {(browser?.tabs ?? []).map((tab) => (
          <div
            className={`browser-tab${tab.active ? " is-active" : ""}`}
            key={tab.id}
            onClick={() => void selectTab(tab.id)}
            role="tab"
            aria-selected={tab.active}
          >
            <BrandMark small />
            <span title={tab.traceId ? `${tab.title} · ${tab.traceId}` : tab.title}>
              {browserTabTitleFromTitle(tab.title, copy)}
            </span>
            {tab.loading ? <i className="tab-spinner" /> : <StateDot state={browserTabTone(tab.status)} />}
            {tab.closable ? (
              <button
                aria-label={copy.hideTab}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.id);
                }}
                title={copy.hideTab}
                type="button"
              >
                <Icon name="close" />
              </button>
            ) : null}
          </div>
        ))}
        <div className="browser-tab-drag draggable" />
      </div>
      <div className="browser-toolbar">
        <div className="browser-history">
          <IconButton
            disabled={navigationLocked || !browser?.canGoBack}
            icon="back"
            label={copy.back}
            onClick={() => void navigate("back")}
          />
          <IconButton
            disabled={navigationLocked || !browser?.canGoForward}
            icon="forward"
            label={copy.forward}
            onClick={() => void navigate("forward")}
          />
          <IconButton disabled={navigationLocked || !visible} icon="reload" label={copy.reload} onClick={() => void navigate("reload")} />
        </div>
        <div className="browser-address" title={browser?.url || copy.browserAddress}>
          <Icon name="globe" />
          <span>{formatBrowserAddress(browser?.url, copy)}</span>
        </div>
        <div className="browser-zoom-controls">
          <IconButton icon="minus" label={copy.zoomOut} onClick={() => void zoom("out")} />
          <button
            aria-label={copy.zoomReset}
            className="browser-zoom-reset"
            onClick={() => void zoom("reset")}
            title={copy.zoomReset}
            type="button"
          >
            {Math.round((browser?.zoomFactor ?? 1) * 100)}%
          </button>
          <IconButton icon="plus" label={copy.zoomIn} onClick={() => void zoom("in")} />
        </div>
        {passkeyAvailable ? (
          <button
            className="toolbar-text-button"
            disabled={passkeyWaiting && passkeyContinuationRequested}
            onClick={() => void (passkeyWaiting ? continuePasskeyLogin() : openPasskeyLogin())}
            type="button"
          >
            {passkeyWaiting
              ? passkeyContinuationRequested ? copy.passkeyImporting : copy.passkeyContinue
              : copy.passkeySignIn}
          </button>
        ) : null}
        <button className="toolbar-text-button" onClick={() => void toggle()} type="button">
          {visible ? copy.hideBrowser : copy.openChatgpt}
        </button>
        {browser?.loading ? <i className="browser-loading-line" /> : null}
      </div>
      {selectedManualTab
        && ["awaiting-user", "sent"].includes(selectedManualTab.manualState ?? "") ? (
        <ManualTurnGuide
          copy={copy}
          onCancel={() => void closeTab(selectedManualTab.id)}
          onCopy={() => void copyManualPrompt(selectedManualTab.id)}
          onSent={() => void confirmManualSent(selectedManualTab.id)}
          tab={selectedManualTab}
        />
      ) : null}
      <div className="browser-viewport" ref={browserSlotRef}>
        {!visible ? (
          <div className="browser-empty">
            <BrandMark />
            <h1>{manualInteraction
              ? copy.browserReady
              : browser?.authenticated ? copy.noActiveTask : copy.stepAccount}</h1>
            <p>{manualInteraction
              ? copy.stepAccountBody
              : browser?.authenticated
              ? copy.noActiveTaskBody
              : passkeyWaiting ? copy.passkeyContinueBody : copy.stepAccountBody}</p>
            <div className="browser-empty-actions">
              <PrimaryButton disabled={passkeyWaiting} onClick={() => void toggle()}>
                {manualInteraction || browser?.authenticated ? copy.openChatgpt : copy.signIn}
              </PrimaryButton>
              {passkeyAvailable ? (
                <SecondaryButton
                  disabled={passkeyWaiting && passkeyContinuationRequested}
                  onClick={passkeyWaiting ? continuePasskeyLogin : openPasskeyLogin}
                >
                  {passkeyWaiting
                    ? passkeyContinuationRequested ? copy.passkeyImporting : copy.passkeyContinue
                    : copy.passkeySignIn}
                </SecondaryButton>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="browser-underlay" aria-hidden="true">
            <span>{copy.loading}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ManualTurnGuide({
  copy,
  onCancel,
  onCopy,
  onSent,
  tab,
}: {
  copy: Copy;
  onCancel: () => void;
  onCopy: () => void;
  onSent: () => void;
  tab: BrowserState["tabs"][number];
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (tab.manualState !== "awaiting-user" || !tab.manualDeadlineAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [tab.manualDeadlineAt, tab.manualState]);
  const deadline = tab.manualDeadlineAt ? Date.parse(tab.manualDeadlineAt) : Number.NaN;
  const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1_000)) : 0;
  const waiting = tab.manualState === "awaiting-user";
  const status = waiting
    ? `${seconds} ${copy.manualPromptSeconds}`
    : tab.manualState === "sent"
      ? copy.manualPromptSent
      : tab.manualState === "running"
        ? copy.manualPromptRunning
        : tab.manualState === "completed"
          ? copy.complete
          : copy.failed;
  return (
    <div className={`manual-turn-guide${waiting ? " is-waiting" : ""}`}>
      <div>
        <strong>{waiting ? copy.manualPromptTitle : copy.manualPromptWaiting}</strong>
        {waiting ? <p>{copy.manualPromptInstruction}</p> : null}
      </div>
      <span className="manual-turn-status">{status}</span>
      <div className="manual-turn-actions">
        <SecondaryButton onClick={onCancel}>{copy.manualPromptCancel}</SecondaryButton>
        <SecondaryButton disabled={!tab.canCopyPrompt} onClick={onCopy}>{copy.manualPromptCopy}</SecondaryButton>
        <PrimaryButton disabled={!tab.canConfirmSent} onClick={onSent}>{copy.manualPromptSent}</PrimaryButton>
      </div>
    </div>
  );
}

function SetupSurface({
  activateBrowser,
  browser,
  copy,
  devProfile,
  operation,
  setError,
  showMcp,
  snapshot,
  updateState,
}: {
  activateBrowser: (show?: boolean) => Promise<void>;
  browser: BrowserState | null;
  copy: Copy;
  devProfile: boolean;
  operation: OperationState | null;
  setError: (error: string | null) => void;
  showMcp: () => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const manualInteraction = snapshot.state.browserInteractionMode === "manual";
  const busy = localBusy
    || operation?.status === "running"
    || (!manualInteraction && (
      browser?.status === "loading"
      || browser?.status === "testing"
      || browser?.status === "running"
    ));
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setLocalBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLocalBusy(false);
    }
  };

  const openLogin = () => run(async () => {
    await activateBrowser();
    await api!.openLogin();
  });
  const smoke = () => run(async () => {
    await activateBrowser();
    await api!.smokeTest();
    updateState((await api!.snapshot()).state);
  });
  const install = () => run(async () => {
    await api!.setupCore();
    updateState((await api!.snapshot()).state);
  });
  const setZeroRiskPro = (enabled: boolean) => run(async () => {
    updateState(await api!.setZeroRiskPro(enabled));
  });

  return (
    <ContentSurface
      eyebrow={copy.required}
      subtitle={devProfile
        ? copy.devSetupSubtitle
        : manualInteraction ? copy.manualInteractionBody : copy.setupSubtitle}
      title={devProfile ? copy.devSetupTitle : copy.setupTitle}
    >
      <SectionHeading label={devProfile ? copy.devCoreSetup : copy.coreSetup} />
      <div className="setup-list">
        {!manualInteraction ? <>
          <SetupRow
            action={browser?.authenticated
              ? copy.signedIn
              : browser?.status === "loading" ? copy.checkingSignIn : copy.signIn}
            complete={browser?.authenticated === true}
            description={copy.stepAccountBody}
            disabled={busy}
            index={1}
            onAction={openLogin}
            title={copy.stepAccount}
          />
          <SetupRow
            action={snapshot.smokePassed ? copy.smokePassed : copy.runSmoke}
            complete={snapshot.smokePassed}
            description={copy.stepSmokeBody}
            disabled={busy || !browser?.authenticated}
            index={2}
            onAction={smoke}
            title={copy.stepSmoke}
          />
        </> : null}
        <SetupRow
          action={snapshot.state.coreSetupComplete
            ? devProfile ? copy.devReinstall : copy.reinstall
            : devProfile ? copy.devInstall : copy.install}
          complete={snapshot.state.codexCatalogVerified === true}
          description={devProfile ? copy.devStepInstallBody : copy.stepInstallBody}
          disabled={busy || (!snapshot.smokePassed && snapshot.state.coreSetupComplete !== true)}
          index={manualInteraction ? 1 : 3}
          onAction={install}
          repeatable
          title={devProfile ? copy.devStepInstall : copy.stepInstall}
          titleAction={manualInteraction ? (
            <ZeroRiskModelMenu
              busy={busy || snapshot.state.coreSetupComplete !== true}
              copy={copy}
              proEnabled={snapshot.state.zeroRiskProEnabled}
              onChange={(enabled) => void setZeroRiskPro(enabled)}
            />
          ) : undefined}
        />
      </div>

      {!devProfile && snapshot.state.codexRestartRequired ? (
        <NoticeRow icon="alert" tone="warning">
          {copy.restartCodex}
        </NoticeRow>
      ) : null}

      <SectionHeading label="MCP" meta={manualInteraction ? copy.required : copy.optional} spaced />
      <button
        className="next-surface-row"
        disabled={!manualInteraction && !snapshot.state.codexCatalogVerified}
        onClick={showMcp}
        type="button"
      >
        <McpMark />
        <span>
          <strong>{devProfile ? copy.devMcpTitle : copy.mcpTitle}</strong>
          <small>{devProfile ? copy.devMcpBody : copy.mcpBody}</small>
        </span>
        <em>{snapshot.state.mcpSetupComplete ? copy.mcpReady : copy.configureMcp}</em>
        <Icon name="chevron" />
      </button>
    </ContentSurface>
  );
}

function McpSurface({
  copy,
  devProfile,
  interactionMode,
  language,
  onDone,
  operation,
  platform,
  setError,
  snapshot,
  updateState,
}: {
  copy: Copy;
  devProfile: boolean;
  interactionMode: BrowserInteractionMode;
  language: Language;
  onDone: () => void;
  operation: OperationState | null;
  platform: string;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const configuringInactiveMode = interactionMode !== snapshot.state.browserInteractionMode;
  const [step, setStep] = useState(
    configuringInactiveMode ? 1 : Math.min(2, Math.max(0, snapshot.state.mcpGuideStep || 0)),
  );
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [credentialsConfigured, setCredentialsConfigured] = useState(
    interactionMode === snapshot.state.browserInteractionMode
      ? snapshot.mcpCredentialsConfigured
      : false,
  );
  const [replacingCredentials, setReplacingCredentials] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [nativeComputerUseReady, setNativeComputerUseReady] = useState(false);
  const busy = localBusy || operation?.status === "running";
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const verified = !configuringInactiveMode && snapshot.state.mcpSetupComplete === true;
  const manualInteraction = interactionMode === "manual";
  const steps = useMemo(() => [
    { title: copy.mcpStepOne, body: copy.mcpStepOneBody },
    { title: copy.mcpStepTwo, body: copy.mcpStepTwoBody },
    {
      title: copy.mcpStepThree,
      body: manualInteraction ? copy.manualMcpStepThreeBody : copy.mcpStepThreeBody,
    },
  ], [copy, manualInteraction]);
  const guideMedia = MCP_GUIDE_MEDIA[step];

  const move = async (next: number) => {
    setStep(next);
    updateState(await api!.setMcpStep(next));
  };
  const safeMove = async (next: number) => {
    if (busy) return;
    setError(null);
    try {
      await move(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const openExternal = async (url: string) => {
    setError(null);
    try {
      await api!.openExternal(url);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const install = async () => {
    if (busy) return;
    setLocalBusy(true);
    setError(null);
    try {
      await api!.setupMcp({
        interactionMode,
        ...(credentialsConfigured && !replacingCredentials
          ? { replace: false }
          : { tunnelId, runtimeKey, replace: true }),
      });
      setRuntimeKey("");
      setTunnelId("");
      setCredentialsConfigured(true);
      setReplacingCredentials(false);
      updateState((await api!.snapshot()).state);
      await move(2);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLocalBusy(false);
    }
  };
  const verify = async () => {
    if (busy) return;
    setLocalBusy(true);
    setError(null);
    setDoctor(null);
    try {
      setDoctor(await api!.verifyMcp());
      updateState((await api!.snapshot()).state);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLocalBusy(false);
    }
  };
  const setupNativeComputerUse = async () => {
    if (busy) return;
    setLocalBusy(true);
    setError(null);
    try {
      await api!.setupNativeComputerUse();
      setNativeComputerUseReady(true);
      updateState((await api!.snapshot()).state);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <ContentSurface
      fit
      subtitle={devProfile ? copy.devMcpSubtitle : copy.mcpSubtitle}
      title={devProfile ? copy.devMcpTitle : "MCP"}
    >
      {!manualInteraction && !configuringInactiveMode && !snapshot.state.codexCatalogVerified ? (
        <NoticeRow icon="setup" tone="warning">{copy.mcpCatalogRequired}</NoticeRow>
      ) : null}

      <div className="wizard-stepper" aria-label={`${step + 1} / 3`}>
        {steps.map((item, index) => (
          <button
            className={`${index === step ? "is-active" : ""}${index < step || (index === 2 && verified) ? " is-complete" : ""}`}
            disabled={busy || index > step}
            key={item.title}
            onClick={() => void safeMove(index)}
            type="button"
          >
            <span>{index < step || (index === 2 && verified) ? <Icon name="check" /> : index + 1}</span>
            <em>{item.title}</em>
          </button>
        ))}
      </div>

      <div className="mcp-stage">
        {guideMedia ? (
          <TutorialVideo
            copy={copy}
            label={`${copy.guideVideo}: ${steps[step]!.title}`}
            src={guideMedia}
          />
        ) : null}

        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            animate={{ opacity: 1, x: 0 }}
            className="wizard-content"
            exit={{ opacity: 0, x: -8 }}
            initial={{ opacity: 0, x: 8 }}
            key={step}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <header>
              <span>0{step + 1}</span>
              <div>
                <h2>{steps[step]!.title}</h2>
                <p>{steps[step]!.body}</p>
              </div>
            </header>

            {step === 0 ? (
              <div className="inline-actions">
                <SecondaryButton icon="external" onClick={() => void openExternal(snapshot.urls.tunnels)}>
                  {copy.openTunnels}
                </SecondaryButton>
                <SecondaryButton icon="external" onClick={() => void openExternal(snapshot.urls.keys)}>
                  {copy.openKeys}
                </SecondaryButton>
              </div>
            ) : null}
            {step === 1 ? (
              credentialsConfigured && !replacingCredentials ? (
                <div className="saved-credentials">
                  <NoticeRow icon="check" tone="success">
                    <span>
                      <strong>{copy.credentialsConfigured}</strong>
                      <small>{copy.credentialsConfiguredBody}</small>
                    </span>
                  </NoticeRow>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setReplacingCredentials(true)}
                    type="button"
                  >
                    {copy.replaceCredentials}
                  </button>
                </div>
              ) : (
                <div className="field-list">
                  <FieldRow label={copy.tunnelId}>
                    <input
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => setTunnelId(event.target.value)}
                      placeholder="tunnel_…"
                      spellCheck={false}
                      value={tunnelId}
                    />
                  </FieldRow>
                  <FieldRow label={copy.runtimeKey}>
                    <input
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => setRuntimeKey(event.target.value)}
                      placeholder="sk-…"
                      spellCheck={false}
                      type="password"
                      value={runtimeKey}
                    />
                  </FieldRow>
                  {credentialsConfigured ? (
                    <button
                      className="text-button keep-credentials"
                      disabled={busy}
                      onClick={() => {
                        setTunnelId("");
                        setRuntimeKey("");
                        setReplacingCredentials(false);
                      }}
                      type="button"
                    >
                      {copy.keepCredentials}
                    </button>
                  ) : null}
                </div>
              )
            ) : null}
            {step === 1 ? (
              <p className="mcp-step-two-hint">
                {manualInteraction || configuringInactiveMode || snapshot.state.codexCatalogVerified
                  ? copy.mcpStepTwoHint
                  : copy.mcpCatalogRequired}
              </p>
            ) : null}
            {step === 1 && !devProfile && platform === "win32" ? (
              <div className="native-computer-use-actions">
                <NoticeRow icon="mcp" tone={nativeComputerUseReady ? "success" : "warning"}>
                  <span>
                    <strong>{nativeComputerUseReady ? copy.nativeComputerUseReady : copy.nativeComputerUseTitle}</strong>
                    <small>{copy.nativeComputerUseBody}</small>
                  </span>
                </NoticeRow>
                <SecondaryButton disabled={busy} onClick={() => void setupNativeComputerUse()}>
                  {nativeComputerUseReady ? copy.nativeComputerUseReadyAction : copy.installNativeComputerUse}
                </SecondaryButton>
              </div>
            ) : null}
            {step === 2 ? (
              <div className="connector-actions">
                <NoticeRow icon="alert" tone="warning">
                  {manualInteraction
                    ? copy.manualConnectorNotice
                    : devProfile ? copy.devConnectorIsolationNotice : copy.connectorMigrationNotice}
                </NoticeRow>
                <div className="connector-name">
                  <span>{copy.connectorName}</span>
                  <code>{snapshot.connectorNames[interactionMode]}</code>
                </div>
                <div className="inline-actions">
                  <SecondaryButton
                    icon="external"
                    onClick={() => void (async () => {
                      setError(null);
                      try {
                        await api!.openExternal(snapshot.urls.connectors);
                      } catch (cause) {
                        setError(messageOf(cause));
                      }
                    })()}
                  >
                    {copy.openConnectors}
                  </SecondaryButton>
                </div>
                {doctor ? <DoctorSummary copy={copy} language={language} report={doctor} /> : null}
              </div>
            ) : null}
          </motion.section>
        </AnimatePresence>
      </div>

      <div className="wizard-footer">
        <button className="text-button" disabled={step === 0 || busy} onClick={() => void safeMove(step - 1)} type="button">
          {copy.previous}
        </button>
        {step === 0 ? <PrimaryButton disabled={busy} onClick={() => void safeMove(1)}>{copy.next}</PrimaryButton> : null}
        {step === 1 ? (
          <PrimaryButton
            disabled={
              busy
              || (!manualInteraction && !configuringInactiveMode && !snapshot.state.codexCatalogVerified)
              || ((!credentialsConfigured || replacingCredentials) && (!tunnelId || !runtimeKey))
            }
            onClick={() => void install()}
          >
            {busy ? copy.running : credentialsConfigured && !replacingCredentials ? copy.reconnect : copy.connect}
          </PrimaryButton>
        ) : null}
        {step === 2 ? (
          <>
            {verified ? (
              <SecondaryButton disabled={busy} onClick={() => void verify()}>
                {copy.verifyRuntime}
              </SecondaryButton>
            ) : null}
            <PrimaryButton
              disabled={busy}
              onClick={() => void (verified ? onDone() : verify())}
            >
              {busy
                ? operation?.name === "mcp-verification" && operation.status === "running"
                  ? localizeRuntimeMessage(copy, operation.message, undefined, language)
                  : copy.running
                : verified ? copy.done : copy.verifyRuntime}
            </PrimaryButton>
          </>
        ) : null}
      </div>
    </ContentSurface>
  );
}

function ActivitySurface({
  copy,
  language,
  logs,
  setError,
}: {
  copy: Copy;
  language: Language;
  logs: LogRecord[];
  setError: (error: string | null) => void;
}) {
  return (
    <ContentSurface subtitle={copy.activitySubtitle} title={copy.activityTitle}>
      <div className="section-heading activity-heading">
        <span>{copy.recentActivity}</span>
        <SecondaryButton
          icon="external"
          onClick={() => void api!.exportLogs().catch((cause) => setError(messageOf(cause)))}
        >
          {copy.exportSafeLog}
        </SecondaryButton>
      </div>
      <div className="activity-table">
        {logs.length === 0 ? (
          <div className="surface-empty">
            <Icon name="logs" />
            <span>{copy.noLogs}</span>
          </div>
        ) : null}
        {[...logs].reverse().map((record, index) => (
          <div className="activity-row" key={`${record.at}-${record.event}-${index}`}>
            <StateDot state={record.level === "error" ? "error" : record.level === "warning" ? "busy" : "ready"} />
            <div>
              <strong>{humanEvent(record.event)}</strong>
              <span>{logDetail(record.detail)}</span>
            </div>
            <time>{formatTime(record.at, language)}</time>
          </div>
        ))}
      </div>
    </ContentSurface>
  );
}

function AccountSwitcherSurface({
  copy,
  language,
  setError,
  setSnapshot,
  snapshot,
}: {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
  setSnapshot: (snapshot: AccountSwitcherSnapshot) => void;
  snapshot: AccountSwitcherSnapshot;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const [showEmails, setShowEmails] = useState(() => {
    try {
      return window.localStorage.getItem("codex-web-gpt.account-emails") === "true";
    } catch {
      return false;
    }
  });
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(snapshot.activeAccountId);

  useEffect(() => {
    try {
      window.localStorage.setItem("codex-web-gpt.account-emails", String(showEmails));
    } catch {}
  }, [showEmails]);

  useEffect(() => {
    if (selectedAccountId && snapshot.accounts.some(account => account.id === selectedAccountId)) return;
    setSelectedAccountId(snapshot.activeAccountId || snapshot.accounts[0]?.id || null);
  }, [selectedAccountId, snapshot.activeAccountId, snapshot.accounts]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      setSnapshot(await api!.accounts({ refreshUsage: snapshot.supported }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const addCurrent = async () => {
    if (refreshing || switchingId !== null || removingId !== null) return;
    setRefreshing(true);
    setError(null);
    try {
      setSnapshot(await api!.addCurrentAccount());
      setAddDialogOpen(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const switchAccount = async (account: CodexAccountSummary) => {
    if (account.isActive || switchingId !== null || !snapshot.officialApp.canSwitch) return;
    setSwitchingId(account.id);
    setSelectedAccountId(account.id);
    setError(null);
    try {
      setSnapshot(await api!.switchAccount(account.id));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSwitchingId(null);
    }
  };

  const addAccount = async () => {
    if (refreshing || switchingId !== null || removingId !== null) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await api!.addAccount();
      if (result) {
        setSnapshot(result);
        setAddDialogOpen(false);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const loginAccount = async () => {
    if (refreshing || switchingId !== null || removingId !== null || loginPending) return;
    setRefreshing(true);
    setError(null);
    try {
      await api!.startAccountLogin();
      setLoginPending(true);
      const result = await api!.completeAccountLogin();
      setSnapshot(result);
      setAddDialogOpen(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoginPending(false);
      setRefreshing(false);
    }
  };

  const cancelLogin = async () => {
    try {
      await api!.cancelAccountLogin();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoginPending(false);
      setRefreshing(false);
    }
  };

  const removeAccount = async (account: CodexAccountSummary) => {
    if (account.isActive || removingId !== null || switchingId !== null || refreshing) return;
    if (!window.confirm(copy.accountSwitcherRemoveConfirm)) return;
    setRemovingId(account.id);
    setError(null);
    try {
      setSnapshot(await api!.removeAccount(account.id));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRemovingId(null);
    }
  };

  const available = snapshot.accounts.filter(account => account.status !== "expired" && account.status !== "unavailable").length;
  const officialTone = !snapshot.officialApp.installed
    ? "error"
    : snapshot.officialApp.running ? "busy" : "ready";
  const selectedAccount = snapshot.accounts.find(account => account.id === selectedAccountId)
    || snapshot.accounts.find(account => account.isActive)
    || snapshot.accounts[0]
    || null;
  const selectedTodayTokens = selectedAccount?.stats ? nativeTokensForRange(selectedAccount.stats, 1) : null;
  const selectedLifetimeTokens = selectedAccount?.stats?.lifetimeTokens ?? null;
  const activeAccount = snapshot.accounts.find(account => account.isActive) || null;

  return (
    <ContentSurface
      subtitle={copy.accountSwitcherSubtitle}
      title={copy.accountSwitcherTitle}
    >
      <div className="accounts-toolbar">
        <div className="accounts-app-state">
          <StateDot state={officialTone} />
          <span>
            <strong>{copy.accountSwitcherOfficialApp}</strong>
            <small>{snapshot.officialApp.running ? copy.accountSwitcherRunning : copy.accountSwitcherNotRunning}</small>
          </span>
        </div>
        <div className="accounts-toolbar-actions">
          <label className="account-email-toggle">
            <span>{showEmails ? copy.accountSwitcherHideEmails : copy.accountSwitcherShowEmails}</span>
            <Switch checked={showEmails} onChange={setShowEmails} />
          </label>
          <SecondaryButton disabled={refreshing || switchingId !== null} icon="reload" onClick={() => void refresh()}>
            {refreshing ? copy.accountSwitcherRefreshing : copy.accountSwitcherRefresh}
          </SecondaryButton>
          <PrimaryButton disabled={!snapshot.supported || refreshing || switchingId !== null || removingId !== null} onClick={() => setAddDialogOpen(true)}>
            {copy.accountSwitcherAddAccount}
          </PrimaryButton>
        </div>
      </div>

      {!snapshot.supported ? (
        <NoticeRow icon="info" tone="warning">{copy.accountSwitcherUnsupported}</NoticeRow>
      ) : null}

      <div className="account-metric-band" aria-label={copy.accountSwitcherAccounts}>
        <AccountMetric value={snapshot.accounts.length} label={copy.accountSwitcherAccounts} />
        <AccountMetric value={available} label={copy.accountSwitcherAvailable} />
        <AccountMetric value={formatTokenCount(selectedTodayTokens)} label={copy.accountSwitcherToday} />
        <div className="account-metric">
          <strong>{formatTokenCount(selectedLifetimeTokens)}</strong>
          <span>{copy.accountSwitcherLifetimeTokens}</span>
        </div>
      </div>

      <div className="account-dashboard-grid">
        <section className="account-panel account-list-panel">
          <div className="account-panel-heading">
            <div>
              <SectionHeading label={copy.accountSwitcherAccounts} meta={snapshot.configured ? copy.accountSwitcherManagedBy : undefined} />
            </div>
            {snapshot.currentSession.present ? (
              <span className="account-session-badge">
                <StateDot state={snapshot.currentSession.managed ? "ready" : "idle"} />
                {copy.accountSwitcherCurrentSession}
              </span>
            ) : null}
          </div>
          {snapshot.accounts.length === 0 ? (
            <div className="account-empty">
              <div className="account-empty-icon"><Icon name="accounts" /></div>
              <strong>{copy.accountSwitcherNoAccounts}</strong>
              <p>{copy.accountSwitcherNoAccountsBody}</p>
              {snapshot.currentSession.present ? (
                <SecondaryButton disabled={refreshing} onClick={() => void addCurrent()}>
                  {copy.accountSwitcherAddCurrent}
                </SecondaryButton>
              ) : null}
            </div>
          ) : (
            <div className="account-card-list">
              {snapshot.accounts.map(account => (
                <AccountCard
                  account={account}
                  busy={switchingId !== null}
                  copy={copy}
                  officialAppCanSwitch={snapshot.officialApp.canSwitch}
                  officialAppRunning={snapshot.officialApp.running}
                  removing={removingId === account.id}
                  selected={selectedAccountId === account.id}
                  showEmail={showEmails}
                  key={account.id}
                  onRemove={() => void removeAccount(account)}
                  onSelect={() => setSelectedAccountId(account.id)}
                  onSwitch={() => void switchAccount(account)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="account-panel account-app-panel">
          <SectionHeading label={copy.accountSwitcherOfficialApp} />
          <div className="account-app-status">
            <StateDot state={officialTone} />
            <div>
              <strong>{snapshot.officialApp.running ? copy.accountSwitcherRunning : copy.accountSwitcherNotRunning}</strong>
              <p>{snapshot.officialApp.message}</p>
            </div>
          </div>
          <div className="account-app-facts">
            <div><span>{copy.version}</span><strong>{snapshot.officialApp.version || copy.accountSwitcherUnavailable}</strong></div>
            <div><span>{copy.status}</span><strong>{snapshot.officialApp.installed ? copy.healthy : copy.accountSwitcherUnavailable}</strong></div>
            <div><span>{copy.accountSwitcherCurrentAccount}</span><strong>{activeAccount ? formatAccountDisplayName(activeAccount, showEmails) : copy.accountSwitcherUnavailable}</strong></div>
          </div>
          <p className="account-app-note">{copy.accountSwitcherOfficialAppBody}</p>
        </section>
      </div>

      <AccountActivityPanel account={selectedAccount} copy={copy} language={language} showEmail={showEmails} snapshot={snapshot} />
      {addDialogOpen ? (
        <AccountAddModal
          busy={refreshing}
          copy={copy}
          loginPending={loginPending}
          onAddCurrent={() => void addCurrent()}
          onCancelLogin={() => void cancelLogin()}
          onClose={() => {
            if (loginPending) void cancelLogin();
            setAddDialogOpen(false);
          }}
          onImport={() => void addAccount()}
          onLogin={() => void loginAccount()}
        />
      ) : null}
    </ContentSurface>
  );
}

function AccountAddModal({
  busy,
  copy,
  loginPending,
  onAddCurrent,
  onCancelLogin,
  onClose,
  onImport,
  onLogin,
}: {
  busy: boolean;
  copy: Copy;
  loginPending: boolean;
  onAddCurrent: () => void;
  onCancelLogin: () => void;
  onClose: () => void;
  onImport: () => void;
  onLogin: () => void;
}) {
  return (
    <div className="account-modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !loginPending) onClose();
    }}>
      <div aria-modal="true" className="account-add-modal" role="dialog">
        <div className="account-add-modal-heading">
          <div>
            <span className="eyebrow">{copy.accountSwitcher}</span>
            <h2>{copy.accountSwitcherAddAccount}</h2>
          </div>
          <button aria-label={copy.close} className="icon-button" disabled={busy || loginPending} onClick={onClose} type="button">
            <Icon name="close" />
          </button>
        </div>
        <p className="account-add-modal-body">{copy.accountSwitcherAddAccountBody}</p>
        {loginPending ? (
          <div className="account-login-pending">
            <span className="account-login-spinner" />
            <div>
              <strong>{copy.accountSwitcherLoginWaiting}</strong>
              <span>{copy.accountSwitcherLoginWaitingBody}</span>
            </div>
            <SecondaryButton onClick={onCancelLogin}>{copy.close}</SecondaryButton>
          </div>
        ) : (
          <div className="account-add-options">
            <button className="account-add-option is-primary" disabled={busy} onClick={onLogin} type="button">
              <span className="account-add-option-icon"><Icon name="accounts" /></span>
              <span><strong>{copy.accountSwitcherLogin}</strong><small>{copy.accountSwitcherLoginBody}</small></span>
            </button>
            <button className="account-add-option" disabled={busy} onClick={onImport} type="button">
              <span className="account-add-option-icon"><Icon name="plus" /></span>
              <span><strong>{copy.accountSwitcherImportFile}</strong><small>{copy.accountSwitcherImportFileBody}</small></span>
            </button>
            <button className="account-add-current" disabled={busy} onClick={onAddCurrent} type="button">
              {copy.accountSwitcherAddCurrent}
            </button>
          </div>
        )}
        <div className="account-add-modal-footer">
          <span>{copy.accountSwitcherCredentialsLocal}</span>
          <SecondaryButton disabled={busy || loginPending} onClick={onClose}>{copy.close}</SecondaryButton>
        </div>
      </div>
    </div>
  );
}

function AccountMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="account-metric">
      <motion.strong animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 4 }} key={value}>
        {typeof value === "number" ? value.toLocaleString("en-US") : value}
      </motion.strong>
      <span>{label}</span>
    </div>
  );
}

function AccountCard({
  account,
  busy,
  copy,
  officialAppCanSwitch,
  officialAppRunning,
  onRemove,
  onSelect,
  onSwitch,
  removing,
  selected,
  showEmail,
}: {
  account: CodexAccountSummary;
  busy: boolean;
  copy: Copy;
  officialAppCanSwitch: boolean;
  officialAppRunning: boolean;
  onRemove: () => void;
  onSelect: () => void;
  onSwitch: () => void;
  removing: boolean;
  selected: boolean;
  showEmail: boolean;
}) {
  const status = accountStatusCopy(account.status, copy);
  const auth = account.authMode === "chatgpt" ? copy.accountSwitcherAuthChatGPT
    : account.authMode === "api-key" ? copy.accountSwitcherAuthApiKey : copy.accountSwitcherUnavailable;
  const lastUsed = account.lastUsedAt ? formatCompactDate(account.lastUsedAt) : copy.accountSwitcherNever;
  const expiry = account.subscriptionExpiresAt ? ` · ${formatCompactDate(account.subscriptionExpiresAt)}` : "";
  const email = formatAccountEmail(account.email, showEmail);
  const displayName = formatAccountDisplayName(account, showEmail);
  const credit = accountCreditCopy(account, copy);
  const resetCredits = account.stats?.resetCreditsAvailable;
  return (
    <article className={`account-card${account.isActive ? " is-active" : ""}${selected ? " is-selected" : ""}`}>
      <div className="account-card-topline">
        <div className="account-card-identity">
          <AccountAvatar account={account} />
          <div>
            <strong>{displayName}</strong>
            <span>{email || auth}</span>
          </div>
        </div>
        <span className={`account-status-pill is-${account.status}`}><StateDot state={account.status === "expired" || account.status === "unavailable" ? "error" : account.isActive ? "ready" : "idle"} />{status}</span>
      </div>
      <div className="account-card-details">
        <span>{account.plan || auth}</span>
        <span>{account.isActive ? copy.accountSwitcherActive : `${copy.accountSwitcherLastSwitch}: ${lastUsed}`}{expiry}</span>
      </div>
      <div className="account-entitlements">
        <span className={`account-entitlement is-${credit.tone}`}>{credit.label}</span>
        {resetCredits !== null && resetCredits !== undefined ? (
          <span className={`account-entitlement ${resetCredits > 0 ? "is-positive" : "is-muted"}`}>
            {resetCredits > 0 ? `${copy.accountSwitcherResetCredits}: ${formatCount(resetCredits)}` : copy.accountSwitcherNoResetCredits}
            {resetCredits > 0 && account.stats?.resetCreditsNextExpiresAt ? ` · ${copy.accountSwitcherExpires} ${formatCompactDateTime(account.stats.resetCreditsNextExpiresAt)}` : ""}
          </span>
        ) : null}
      </div>
      {account.usage?.available ? (
        <div className="account-usage-grid">
          <AccountUsageWindow
            copy={copy}
            label={copy.accountSwitcherSessionWindow}
            resetsAt={account.usage.primaryResetsAt}
            usedPercent={account.usage.primaryUsedPercent}
          />
          <AccountUsageWindow
            copy={copy}
            label={copy.accountSwitcherWeeklyWindow}
            resetsAt={account.usage.secondaryResetsAt}
            usedPercent={account.usage.secondaryUsedPercent}
          />
        </div>
      ) : (
        <div className="account-usage-unavailable">
          {account.usage?.error || copy.accountSwitcherUsageUnavailable}
        </div>
      )}
      <div className="account-card-footer">
        <code>{account.shortId || "local"}</code>
        <div className="account-card-actions">
          <button className={`account-view-button${selected ? " is-selected" : ""}`} onClick={onSelect} type="button">
            {selected ? copy.accountSwitcherViewingStats : copy.accountSwitcherViewStats}
          </button>
          {!account.isActive ? (
            <button className="account-remove-button" disabled={removing || busy} onClick={onRemove} type="button">
              {removing ? copy.accountSwitcherRemoving : copy.accountSwitcherRemoveAccount}
            </button>
          ) : null}
          <button
            className="account-switch-button"
            disabled={!officialAppCanSwitch || account.isActive || busy || removing || account.status === "expired" || account.status === "unavailable"}
            onClick={onSwitch}
            type="button"
          >
            {account.isActive
              ? copy.accountSwitcherActive
              : busy
                ? copy.accountSwitcherSwitching
                : officialAppRunning
                  ? copy.accountSwitcherSwitchAndRestart
                  : copy.accountSwitcherApplyNextLaunch}
          </button>
        </div>
      </div>
    </article>
  );
}

function AccountAvatar({ account }: { account: CodexAccountSummary }) {
  const [failed, setFailed] = useState(false);
  if (account.avatarUrl && !failed) {
    return (
      <img
        alt=""
        className="account-avatar account-avatar-image"
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        src={account.avatarUrl}
      />
    );
  }
  return <span className="account-avatar">{formatAccountDisplayName(account, true).slice(0, 1).toUpperCase()}</span>;
}

function accountCreditCopy(account: CodexAccountSummary, copy: Copy): { label: string; tone: "positive" | "muted" | "warning" } {
  const usage = account.usage;
  if (usage?.unlimitedCredits === true) return { label: copy.accountSwitcherUnlimitedCredits, tone: "positive" };
  if (usage?.hasCredits === true) {
    return {
      label: usage.creditsBalance ? `${copy.accountSwitcherCredits}: ${usage.creditsBalance}` : copy.accountSwitcherCreditsAvailable,
      tone: "positive",
    };
  }
  if (usage?.hasCredits === false) return { label: copy.accountSwitcherNoCredits, tone: "warning" };
  return { label: copy.accountSwitcherCreditsUnavailable, tone: "muted" };
}

function AccountUsageWindow({
  copy,
  label,
  resetsAt,
  usedPercent,
}: {
  copy: Copy;
  label: string;
  resetsAt: string | null;
  usedPercent: number | null;
}) {
  const remaining = usedPercent === null ? null : Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
  return (
    <div className="account-usage-window">
      <div className="account-usage-label"><span>{label}</span><strong>{remaining === null ? "—" : `${remaining}% ${copy.accountSwitcherLeft}`}</strong></div>
      <div aria-hidden="true" className="account-usage-track"><i style={{ width: `${remaining ?? 0}%` }} /></div>
      {resetsAt ? <small>{formatResetDate(resetsAt, copy)}</small> : null}
    </div>
  );
}

function AccountActivityPanel({
  account,
  copy,
  language,
  showEmail,
  snapshot,
}: {
  account: CodexAccountSummary | null;
  copy: Copy;
  language: Language;
  showEmail: boolean;
  snapshot: AccountSwitcherSnapshot;
}) {
  const nativeStats = account?.stats ?? null;
  const nativeDays = nativeActivityDays(nativeStats);
  const activityDays = nativeDays ?? snapshot.activity.daily.map(day => ({
    date: day.date,
    value: day.count,
  }));
  const activityMaximum = Math.max(1, ...activityDays.map(day => day.value));
  const hasNativeActivity = nativeDays !== null;
  return (
    <section className="account-panel account-activity-panel">
      <div className="account-panel-heading">
        <div>
          <SectionHeading label={hasNativeActivity ? copy.accountSwitcherTokenActivity : copy.accountSwitcherActivity} />
          <p className="account-panel-subtitle">
            {hasNativeActivity
              ? `${account ? formatAccountDisplayName(account, showEmail) : copy.accountSwitcherCurrentAccount} · ${copy.accountSwitcherTokenActivityBody}`
              : copy.accountSwitcherActivityBody}
          </p>
        </div>
        <div className="account-activity-summary">
          {hasNativeActivity && nativeStats ? (
            <>
              <strong>{formatTokenCount(nativeStats.lifetimeTokens)}</strong><span>{copy.accountSwitcherLifetimeTokens}</span>
              <strong>{formatDuration(nativeStats.longestTaskSeconds)}</strong><span>{copy.accountSwitcherLongestTask}</span>
            </>
          ) : (
            <>
              <strong>{snapshot.activity.activeDays}</strong><span>{copy.accountSwitcherActive}</span>
              <strong>{snapshot.activity.totalSwitches}</strong><span>{copy.accountSwitcherSwitchesToday}</span>
            </>
          )}
        </div>
      </div>
      {hasNativeActivity && nativeStats ? (
        <div className="account-native-stats">
          <AccountNativeStat label={copy.accountSwitcherToday} value={formatTokenCount(nativeTokensForRange(nativeStats, 1))} />
          <AccountNativeStat label={copy.accountSwitcherLastSevenDays} value={formatTokenCount(nativeTokensForRange(nativeStats, 7))} />
          <AccountNativeStat label={copy.accountSwitcherStreak} value={formatDays(nativeStats.currentStreakDays)} />
          <AccountNativeStat label={copy.accountSwitcherLongestStreak} value={formatDays(nativeStats.longestStreakDays)} />
          <AccountNativeStat label={copy.accountSwitcherLongestTask} value={formatDuration(nativeStats.longestTaskSeconds)} />
          <AccountNativeStat label={copy.accountSwitcherResetCredits} value={nativeStats.resetCreditsAvailable === null ? "—" : formatCount(nativeStats.resetCreditsAvailable)} />
          <AccountNativeStat label={copy.accountSwitcherPeakDailyTokens} value={formatTokenCount(nativeStats.peakDailyTokens)} />
          <AccountNativeStat label={copy.accountSwitcherThreads} value={formatCount(nativeStats.totalThreads)} />
        </div>
      ) : null}
      <div className="account-heatmap-wrap">
        <div className="account-heatmap" role="grid" aria-label={copy.accountSwitcherActivity}>
          {activityDays.map(day => (
            <span
              aria-label={`${day.date}: ${hasNativeActivity ? formatTokenCount(day.value) : day.value}`}
              className={`account-heat-cell level-${activityLevel(day.value, activityMaximum)}`}
              key={day.date}
              role="gridcell"
              title={`${day.date}: ${hasNativeActivity ? formatTokenCount(day.value) : day.value}`}
            />
          ))}
        </div>
        <div className="account-heat-legend"><span>{copy.accountSwitcherHeatmapLess}</span><i className="level-0" /><i className="level-1" /><i className="level-2" /><i className="level-3" /><span>{copy.accountSwitcherHeatmapMore}</span></div>
      </div>
      {hasNativeActivity && activityDays.every(day => day.value === 0) ? (
        <p className="account-no-recent">{copy.accountSwitcherNoTokenActivity}</p>
      ) : null}
      <div className="account-recent-heading"><SectionHeading label={copy.accountSwitcherRecentSwitches} /></div>
      {snapshot.activity.recent.length === 0 ? (
        <p className="account-no-recent">{copy.accountSwitcherNoRecentActivity}</p>
      ) : (
        <div className="account-recent-list">
          {snapshot.activity.recent.slice(0, 6).map(event => {
            const eventAccount = snapshot.accounts.find(candidate => candidate.id === event.accountId);
            const eventName = eventAccount
              ? formatAccountDisplayName(eventAccount, showEmail)
              : formatAccountDisplayName({ name: event.accountName, email: null }, showEmail);
            return (
              <div className="account-recent-row" key={`${event.at}-${event.accountId}-${event.kind}`}>
                <StateDot state="ready" />
                <span><strong>{eventName}</strong><small>{event.kind === "import" ? copy.accountSwitcherImported : copy.accountSwitcherSwitched}</small></span>
                <time>{formatActivityDate(event.at, language)}</time>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AccountNativeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="account-native-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function nativeActivityDays(stats: AccountUsageStats | null): Array<{ date: string; value: number }> | null {
  if (!stats?.available) return null;
  const values = new Map(stats.daily.map(day => [dateKey(day.date), day.tokens] as const).filter(([date]) => date));
  const today = new Date();
  return Array.from({ length: 84 }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (83 - index)));
    const key = date.toISOString().slice(0, 10);
    return { date: key, value: values.get(key) ?? 0 };
  });
}

function dateKey(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match) return match[1];
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function nativeTokensForRange(stats: AccountUsageStats, days: number): number | null {
  if (!stats.available) return null;
  const values = new Map(stats.daily.map(day => [dateKey(day.date), day.tokens] as const).filter(([date]) => date));
  const today = new Date();
  let total = 0;
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    total += values.get(date.toISOString().slice(0, 10)) ?? 0;
  }
  return total;
}

function activityLevel(value: number, maximum: number): number {
  if (value <= 0) return 0;
  const ratio = value / Math.max(1, maximum);
  if (ratio >= 0.75) return 3;
  if (ratio >= 0.35) return 2;
  return 1;
}

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function formatDays(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}d`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokenCount(value: number | null): string {
  if (value === null) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function accountStatusCopy(status: CodexAccountSummary["status"], copy: Copy): string {
  if (status === "active") return copy.accountSwitcherActive;
  if (status === "expired") return copy.accountSwitcherExpired;
  if (status === "unavailable") return copy.accountSwitcherUnavailable;
  return copy.accountSwitcherReady;
}

function formatCompactDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatCompactDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatResetDate(value: string, copy: Copy): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const remaining = date.getTime() - Date.now();
  if (remaining <= 0) return copy.accountSwitcherResetsNow;
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${copy.accountSwitcherResetsIn} ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${copy.accountSwitcherResetsIn} ${hours}h`;
  return `${copy.accountSwitcherResetsOn} ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function formatActivityDate(value: string, language: Language): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(
    language === "ja" ? "ja-JP" : language === "zh-CN" ? "zh-CN" : "en-US",
    { month: "short", day: "numeric" },
  );
}

function SettingsSurface({
  configureInteractionMode,
  copy,
  devProfile,
  language,
  setError,
  snapshot,
  updateState,
}: {
  configureInteractionMode: (mode: BrowserInteractionMode) => void;
  copy: Copy;
  devProfile: boolean;
  language: Language;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnsCancelled, setTurnsCancelled] = useState(false);
  const [integrationRemoved, setIntegrationRemoved] = useState(false);

  const updateLanguage = async (next: Language) => {
    try {
      updateState(await api!.setLanguage(next));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const runDoctor = async () => {
    setBusy(true);
    try {
      setDoctor(await api!.doctor());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancelTurns = async () => {
    setBusy(true);
    setError(null);
    try {
      await api!.cancelTurns();
      setTurnsCancelled(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setBiggerContext = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setBiggerContext(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setSkillAttachments = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setSkillAttachments(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setWallpapers = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setWallpapersEnabled(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setInteractionMode = async (mode: BrowserInteractionMode) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api!.setBrowserInteractionMode(mode);
      updateState(result.state);
      if (result.credentialsRequired) configureInteractionMode(result.targetMode);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const uninstallIntegration = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api!.uninstallIntegration();
      if (!result.cancelled) {
        updateState(result.state);
        setIntegrationRemoved(true);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContentSurface narrow title={devProfile ? copy.devSettingsTitle : copy.settingsTitle}>
      <SectionHeading label={copy.general} />
      <div className="settings-list">
        {!devProfile ? <SettingRow body={copy.launchAtLoginBody} flushAfter label={copy.launchAtLogin}>
          <Switch
            checked={snapshot.state.autoStart}
            onChange={(checked) => void api!.setAutostart(checked)
              .then((result) => updateState(result.state))
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow> : null}
        <InteractionModePicker
          copy={copy}
          disabled={busy}
          mode={snapshot.state.browserInteractionMode}
          onChange={(mode) => void setInteractionMode(mode)}
        />
        <SettingRow body={devProfile ? copy.devKeepRunningBody : copy.keepRunningOnCloseBody} label={copy.keepRunningOnClose}>
          <Switch
            checked={snapshot.state.keepRunningOnClose}
            onChange={(checked) => void api!.setPreference("keepRunningOnClose", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.saveChatsBody} label={copy.saveChats}>
          <Switch checked={snapshot.state.saveChats}
            onChange={checked => void api!.setPreference("saveChats", checked)
              .then(updateState).catch(cause => setError(messageOf(cause)))} />
        </SettingRow>
        {snapshot.state.savedChats?.length > 0 && (
          <SettingRow body={copy.savedChatsBody} label={copy.savedChats}>
            <div>{snapshot.state.savedChats.slice(0, 10).map(chat => (
              <p key={chat.url}><a href={chat.url} onClick={event => {
                event.preventDefault();
                void api!.openExternal(chat.url).catch(cause => setError(messageOf(cause)));
              }}>{chat.title || "ChatGPT"}</a></p>
            ))}</div>
          </SettingRow>
        )}
        <SettingRow body={copy.showDuringTurnsBody} label={copy.showDuringTurns}>
          <Switch
            checked={snapshot.state.showBrowserDuringTurns}
            disabled={snapshot.state.browserInteractionMode === "manual"}
            onChange={(checked) => void api!.setPreference("showBrowserDuringTurns", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.codexWallpapersBody} label={copy.codexWallpapers}>
          <Switch
            checked={snapshot.state.codexWallpapersEnabled}
            disabled={busy}
            onChange={(checked) => void setWallpapers(checked)}
          />
        </SettingRow>
        {snapshot.state.codexWallpapersRestartRequired ? (
          <NoticeRow icon="alert" tone="warning">
            {copy.codexWallpapersRestartRequired}
          </NoticeRow>
        ) : null}
        {snapshot.state.codexWallpapersError ? (
          <NoticeRow icon="alert" tone="warning">
            {snapshot.state.codexWallpapersError}
          </NoticeRow>
        ) : null}
        <SettingRow
          body={snapshot.state.browserInteractionMode === "manual"
            ? copy.manualBiggerContextUnavailable
            : copy.biggerContextBody}
          label={copy.biggerContext}
        >
          <Switch
            checked={snapshot.state.experimentalBiggerContext}
            disabled={busy
              || snapshot.state.browserInteractionMode === "manual"
              || snapshot.state.coreSetupComplete !== true}
            onChange={(checked) => void setBiggerContext(checked)}
          />
        </SettingRow>
        <SettingRow
          body={snapshot.state.browserInteractionMode === "manual"
            ? copy.manualSkillAttachmentsUnavailable
            : copy.skillAttachmentsBody}
          label={copy.skillAttachments}
        >
          <Switch
            checked={snapshot.state.experimentalSkillAttachments}
            disabled={busy
              || snapshot.state.browserInteractionMode === "manual"
              || snapshot.state.coreSetupComplete !== true}
            onChange={(checked) => void setSkillAttachments(checked)}
          />
        </SettingRow>
        <SettingRow body={copy.chooseLanguageHint} label={copy.language}>
          <LanguageMenu copy={copy} language={language} onChange={(next) => void updateLanguage(next)} />
        </SettingRow>
      </div>

      {!devProfile && snapshot.state.codexRestartRequired ? (
        <NoticeRow icon="alert" tone="warning">
          {copy.restartCodex}
        </NoticeRow>
      ) : null}

      <SectionHeading label={copy.diagnostics} spaced />
      <button className="diagnostic-row" disabled={busy} onClick={() => void runDoctor()} type="button">
        <Icon name="activity" />
        <span>
          <strong>{copy.runDoctor}</strong>
          <small>{doctor ? (doctor.ok ? copy.healthy : copy.needsAttention) : copy.status}</small>
        </span>
        <Icon name="chevron" />
      </button>
      {!devProfile ? <button className="diagnostic-row" disabled={busy} onClick={() => void cancelTurns()} type="button">
        <Icon name="close" />
        <span>
          <strong>{copy.cancelTurns}</strong>
          <small>{turnsCancelled ? copy.turnsCancelled : copy.cancelTurnsBody}</small>
        </span>
        <Icon name="chevron" />
      </button> : null}
      {!devProfile ? <button className="diagnostic-row" disabled={busy} onClick={() => void uninstallIntegration()} type="button">
        <Icon name="close" />
        <span>
          <strong>{copy.uninstallIntegration}</strong>
          <small>{integrationRemoved ? copy.integrationRemoved : copy.uninstallIntegrationBody}</small>
        </span>
        <Icon name="chevron" />
      </button> : null}
      {doctor ? <DoctorSummary copy={copy} language={language} report={doctor} /> : null}

      <div className="about-row">
        <BrandMark small />
        <span>
          <strong>{copy.product}</strong>
          <small>
            {devProfile ? `${copy.devBadge} · ${snapshot.profilePaths.coreHome} · ` : ""}
            {platformLabel(snapshot.platform)} · v{snapshot.version}
          </small>
        </span>
      </div>
    </ContentSurface>
  );
}

function ContentSurface({
  children,
  eyebrow,
  fit = false,
  narrow = false,
  subtitle,
  title,
}: {
  children: ReactNode;
  eyebrow?: string;
  fit?: boolean;
  narrow?: boolean;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="content-surface">
      <div className={`content-scroll${narrow ? " is-narrow" : ""}${fit ? " is-fit" : ""}`}>
        <header className="surface-header">
          {eyebrow ? <span>{eyebrow}</span> : null}
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
        {children}
      </div>
    </section>
  );
}

function SetupRow({
  action,
  complete,
  description,
  disabled,
  index,
  onAction,
  onSecondaryAction,
  repeatable = false,
  secondaryAction,
  secondaryDisabled = false,
  title,
  titleAction,
}: {
  action: string;
  complete: boolean;
  description: string;
  disabled: boolean;
  index: number;
  onAction: () => void;
  onSecondaryAction?: () => void;
  repeatable?: boolean;
  secondaryAction?: string;
  secondaryDisabled?: boolean;
  title: string;
  titleAction?: ReactNode;
}) {
  return (
    <div className={`setup-row${complete ? " is-complete" : ""}`}>
      <span className="setup-index">{complete ? <Icon name="check" /> : index}</span>
      <div className="setup-row-copy">
        <div className="setup-row-heading">
          <strong>{title}</strong>
          {titleAction}
        </div>
        <p>{description}</p>
      </div>
      <div className="setup-actions">
        {secondaryAction && onSecondaryAction ? (
          <SecondaryButton disabled={secondaryDisabled || complete} onClick={onSecondaryAction}>
            {secondaryAction}
          </SecondaryButton>
        ) : null}
        <SecondaryButton disabled={disabled || (complete && !repeatable)} onClick={onAction}>
          {action}
        </SecondaryButton>
      </div>
    </div>
  );
}

function ZeroRiskModelMenu({
  busy,
  copy,
  onChange,
  proEnabled,
}: {
  busy: boolean;
  copy: Copy;
  onChange: (enabled: boolean) => void;
  proEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const choose = (enabled: boolean) => {
    setOpen(false);
    if (enabled !== proEnabled) onChange(enabled);
  };

  return (
    <div
      className={`zero-risk-model-menu${open ? " is-open" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={copy.zeroRiskModelSettings}
        className="zero-risk-model-trigger"
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
        title={copy.zeroRiskModelSettings}
        type="button"
      >
        <Icon name="settings" />
      </button>
      {open ? (
        <>
          <button
            aria-label={`${copy.close}: ${copy.zeroRiskModelSettings}`}
            className="zero-risk-model-scrim"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div
            aria-label={copy.zeroRiskModelSettings}
            className="zero-risk-model-panel"
            role="radiogroup"
          >
            <p>{copy.zeroRiskModelSettingsBody}</p>
            <div className="zero-risk-model-option-row">
              <button
                aria-checked={!proEnabled}
                className={!proEnabled ? "is-selected" : ""}
                onClick={() => choose(false)}
                role="radio"
                type="button"
              >
                {!proEnabled ? <span className="zero-risk-model-radio"><Icon name="check" /></span> : null}
                <span>
                  <strong>{copy.zeroRiskDefaultProfile}</strong>
                  <small>{copy.zeroRiskDefaultProfileBody}</small>
                </span>
              </button>
            </div>
            <div className="zero-risk-model-option-row has-info">
              <button
                aria-checked={proEnabled}
                className={proEnabled ? "is-selected" : ""}
                onClick={() => choose(true)}
                role="radio"
                type="button"
              >
                {proEnabled ? <span className="zero-risk-model-radio"><Icon name="check" /></span> : null}
                <span>
                  <strong>{copy.zeroRiskProProfile}</strong>
                  <small>{copy.zeroRiskProProfileBody}</small>
                </span>
              </button>
              <span
                aria-label={copy.zeroRiskProProfileInfo}
                className="zero-risk-model-info"
                role="img"
                tabIndex={0}
              >
                <Icon name="info" />
                <span className="zero-risk-model-tooltip" role="tooltip">
                  {copy.zeroRiskProProfileInfo}
                </span>
              </span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function TutorialVideo({ copy, label, src }: { copy: Copy; label: string; src: string }) {
  const [expanded, setExpanded] = useState(false);
  const inlineVideo = useRef<HTMLVideoElement>(null);
  const expandedVideo = useRef<HTMLVideoElement>(null);
  const expandedAt = useRef(0);

  const closeExpanded = () => {
    const currentTime = expandedVideo.current?.currentTime;
    if (inlineVideo.current && Number.isFinite(currentTime)) {
      inlineVideo.current.currentTime = currentTime ?? 0;
    }
    setExpanded(false);
  };

  useEffect(() => {
    if (!expanded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExpanded();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expanded]);

  return (
    <>
      <div className="guide-media">
        <video aria-label={label} autoPlay loop muted playsInline ref={inlineVideo} src={src} />
        <button
          aria-label={copy.expandGuideVideo}
          className="guide-media-expand"
          onClick={() => {
            expandedAt.current = inlineVideo.current?.currentTime ?? 0;
            setExpanded(true);
          }}
          type="button"
        >
          <Icon name="expand" />
        </button>
      </div>
      {expanded ? createPortal(
        <div
          aria-label={label}
          aria-modal="true"
          className="guide-media is-expanded"
          role="dialog"
        >
          <video
            aria-label={label}
            autoPlay
            loop
            muted
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = expandedAt.current;
            }}
            playsInline
            ref={expandedVideo}
            src={src}
          />
          <button
            aria-label={copy.closeGuideVideo}
            autoFocus
            className="guide-media-close"
            onClick={closeExpanded}
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function SectionHeading({ label, meta, spaced = false }: { label: string; meta?: string; spaced?: boolean }) {
  return (
    <div className={`section-heading${spaced ? " is-spaced" : ""}`}>
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

function NoticeRow({
  children,
  icon,
  tone,
}: {
  children: ReactNode;
  icon: IconName;
  tone: "warning" | "success";
}) {
  return (
    <div className={`notice-row tone-${tone}`}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

function InteractionModePicker({
  className,
  copy,
  disabled,
  mode,
  onChange,
}: {
  className?: string;
  copy: Copy;
  disabled: boolean;
  mode: BrowserInteractionMode;
  onChange: (mode: BrowserInteractionMode) => void;
}) {
  return (
    <div
      aria-label={copy.interactionMode}
      className={`interaction-mode-picker${className ? ` ${className}` : ""}`}
      role="radiogroup"
    >
      <button
        aria-checked={mode === "automatic"}
        className={mode === "automatic" ? "is-selected" : ""}
        disabled={disabled}
        onClick={() => onChange("automatic")}
        role="radio"
        type="button"
      >
        {mode === "automatic" ? (
          <span className="interaction-mode-check"><Icon name="check" /></span>
        ) : null}
        <span>
          <strong>{copy.automaticInteraction}</strong>
          <small>{copy.automaticInteractionBody}</small>
        </span>
      </button>
      <button
        aria-checked={mode === "manual"}
        className={mode === "manual" ? "is-selected" : ""}
        disabled={disabled}
        onClick={() => onChange("manual")}
        role="radio"
        type="button"
      >
        {mode === "manual" ? (
          <span className="interaction-mode-check"><Icon name="check" /></span>
        ) : null}
        <span>
          <strong>{copy.manualInteraction}</strong>
          <small>{copy.manualInteractionBody}</small>
        </span>
      </button>
    </div>
  );
}

function SettingRow({
  body,
  children,
  flushAfter = false,
  label,
}: {
  body: string;
  children: ReactNode;
  flushAfter?: boolean;
  label: string;
}) {
  return (
    <div className={`setting-row${flushAfter ? " is-flush-after" : ""}`}>
      <div>
        <strong>{label}</strong>
        <p>{body}</p>
      </div>
      {children}
    </div>
  );
}

function FieldRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="field-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function DoctorSummary({ copy, language, report }: { copy: Copy; language: Language; report: DoctorReport }) {
  const visibleChecks = report.ok
    ? report.checks.slice(-6)
    : report.checks.filter((check) => check.status !== "ok");
  return (
    <div className={`doctor-summary${report.ok ? " is-healthy" : ""}`}>
      <header>
        <Icon name={report.ok ? "check" : "activity"} />
        <strong>{report.ok ? copy.healthy : copy.needsAttention}</strong>
      </header>
      <div>
        {visibleChecks.map((check) => (
          <p key={check.id}>
            <StateDot state={check.status === "ok" ? "ready" : check.status === "warning" ? "busy" : "error"} />
            <span>{check.status === "ok"
              ? localizeRuntimeMessage(copy, check.message, check.id, language)
              : check.message}{check.nextStep && <><br /><small>{check.nextStep}</small></>}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function WelcomeOption({
  active,
  detail,
  label,
  marker,
  onClick,
}: {
  active: boolean;
  detail: string;
  label: string;
  marker: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-checked={active}
      className={`welcome-option${active ? " is-active" : ""}`}
      onClick={onClick}
      role="radio"
      type="button"
    >
      <span>{marker}</span>
      <strong>{label}</strong>
      <small>{detail}</small>
      {active ? <Icon name="check" /> : null}
    </button>
  );
}

function WelcomeAction({
  complete,
  disabled,
  icon,
  label,
  onClick,
}: {
  complete: boolean;
  disabled?: boolean;
  icon: "github" | "x";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`welcome-option is-social${complete ? " is-complete" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span><Icon name={icon} /></span>
      <strong>{label}</strong>
      <Icon name={complete ? "check" : "external"} />
    </button>
  );
}

function PrimaryButton({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="button-primary" disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  disabled = false,
  icon,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  icon?: IconName;
  onClick: () => void;
}) {
  return (
    <button className="button-secondary" disabled={disabled} onClick={onClick} type="button">
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

function IconButton({
  disabled = false,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="icon-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} />
    </button>
  );
}

function Switch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      className={`switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

const languageOptions = (Object.keys(languages) as Language[]).map(value => ({ value, ...languages[value] }));

function LanguageMenu({ copy, language, onChange }: { copy: Copy; language: Language; onChange: (language: Language) => void }) {
  const [open, setOpen] = useState(false);
  const options = languageOptions;
  const selected = options.find((option) => option.value === language) ?? options[0];

  return (
    <div
      className={`language-menu${open ? " is-open" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="language-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{selected.label}</span>
        <Icon name="chevron" />
      </button>
      {open ? (
        <>
          <button
            aria-label={`${copy.close}: ${copy.language}`}
            className="language-menu-scrim"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div aria-label={copy.language} className="language-menu-panel" role="listbox">
            {options.map((option) => (
              <button
                aria-selected={option.value === language}
                className={option.value === language ? "is-selected" : ""}
                key={option.value}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== language) onChange(option.value);
                }}
                role="option"
                type="button"
              >
                <span>{option.label}</span>
                {option.value === language ? <Icon name="check" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function StateDot({ state }: { state: "idle" | "ready" | "busy" | "error" }) {
  return <i aria-hidden="true" className={`state-dot is-${state}`} />;
}

function ActionDot({ pulse = false, tone }: { pulse?: boolean; tone: "required" | "optional" | "success" | "error" }) {
  return <i aria-hidden="true" className={`action-dot is-${tone}${pulse ? " is-pulse" : ""}`} />;
}

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark${small ? " is-small" : ""}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path
          d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

function ErrorToast({ copy, message, onDismiss }: { copy: Copy; message: string; onDismiss: () => void }) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="error-toast"
      exit={{ opacity: 0, y: 8 }}
      initial={{ opacity: 0, y: 8 }}
      transition={PANEL_TRANSITION}
    >
      <StateDot state="error" />
      <span>
        <strong>{copy.error}</strong>
        <p>{message}</p>
      </span>
      <button onClick={onDismiss} type="button">{copy.dismiss}</button>
    </motion.div>
  );
}

function SessionRefreshReminder({
  busy,
  copy,
  onDismiss,
  onLogout,
}: {
  busy: boolean;
  copy: Copy;
  onDismiss: () => void;
  onLogout: () => void;
}) {
  return (
    <motion.aside
      animate={{ opacity: 1, y: 0 }}
      aria-live="polite"
      className="session-refresh-reminder"
      exit={{ opacity: 0, y: -8 }}
      initial={{ opacity: 0, y: -8 }}
      transition={PANEL_TRANSITION}
    >
      <span className="session-refresh-reminder-icon"><Icon name="alert" /></span>
      <div className="session-refresh-reminder-copy">
        <strong>{copy.sessionReminderTitle}</strong>
        <p>{copy.sessionReminderBody}</p>
      </div>
      <div className="session-refresh-reminder-actions">
        <button className="text-button" disabled={busy} onClick={onDismiss} type="button">
          {copy.dismiss}
        </button>
        <button className="button-primary" disabled={busy} onClick={onLogout} type="button">
          {copy.logOut}
        </button>
      </div>
    </motion.aside>
  );
}

function BiggerContextRecommendation({
  busy,
  checked,
  copy,
  onChange,
  onClose,
}: {
  busy: boolean;
  checked: boolean;
  copy: Copy;
  onChange: (checked: boolean) => void;
  onClose: () => void;
}) {
  return (
    <motion.div
      animate={{ opacity: 1 }}
      aria-describedby="bigger-context-recommendation-body"
      aria-labelledby="bigger-context-recommendation-title"
      aria-modal="true"
      className="bigger-context-recommendation-backdrop"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      role="dialog"
      transition={{ duration: 0.18 }}
    >
      <motion.section
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bigger-context-recommendation"
        exit={{ opacity: 0, scale: 0.98, y: 6 }}
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={PANEL_TRANSITION}
      >
        <header className="bigger-context-recommendation-header">
          <small>{copy.biggerContext}</small>
          <h2 id="bigger-context-recommendation-title">{copy.biggerContextRecommendationTitle}</h2>
        </header>
        <p className="bigger-context-recommendation-body" id="bigger-context-recommendation-body">{copy.biggerContextRecommendationBody}</p>
        <div className="bigger-context-recommendation-toggle">
          <div>
            <strong>{copy.biggerContext}</strong>
            <p>{copy.biggerContextRecommendationToggleBody}</p>
          </div>
          <Switch checked={checked} disabled={busy} onChange={onChange} />
        </div>
        {checked ? <p className="bigger-context-recommendation-restart">{copy.restartCodex}</p> : null}
        <footer>
          <SecondaryButton disabled={busy} onClick={onClose}>{copy.close}</SecondaryButton>
        </footer>
      </motion.section>
    </motion.div>
  );
}

function McpMark() {
  return <i aria-hidden="true" className="mcp-mark" />;
}

function LaunchLoading() {
  return (
    <main className="launch-loading">
      <BrandMark />
      <span />
    </main>
  );
}

function FatalMessage({ message }: { message: string }) {
  return (
    <main className="fatal-message">
      <BrandMark />
      <h1>Codex Web GPT</h1>
      <p>{message}</p>
    </main>
  );
}

function browserTabTitleFromTitle(value: string | undefined, copy: Copy): string {
  const title = value?.trim();
  if (!title || title === "about:blank" || title.includes("codex-web-gpt-browser-host")) return copy.temporaryChat;
  return title.replace(/\s*[|–-]\s*ChatGPT\s*$/i, "") || copy.temporaryChat;
}

function browserTabTone(status: BrowserState["tabs"][number]["status"]): "idle" | "ready" | "busy" | "error" {
  if (status === "error" || status === "aborted") return "error";
  if (status === "loading" || status === "running" || status === "testing") return "busy";
  if (status === "ready") return "ready";
  return "idle";
}

function formatBrowserAddress(url: string | undefined, copy: Copy): string {
  if (!url || url.startsWith("about:blank")) return copy.browserAddress;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "chatgpt.com" && parsed.searchParams.get("temporary-chat") === "true") {
      return `chatgpt.com  /  ${copy.temporaryChat}`;
    }
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return copy.browserAddress;
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function platformLabel(value: string): string {
  return value === "darwin" ? "macOS" : value === "win32" ? "Windows" : value === "linux" ? "Linux" : value;
}

function humanEvent(value: string): string {
  return value.split(".").map((part) => part.replaceAll("_", " ")).join(" · ");
}

function logDetail(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return "";
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

function formatTime(value: string, language: Language): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(languages[language].locale, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}
