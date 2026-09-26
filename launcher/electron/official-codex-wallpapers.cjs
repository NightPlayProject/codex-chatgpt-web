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
const PROVIDER_QUOTA_STATE_KEY = "__codexWebGptNativeQuotaBlocked";
const PROVIDER_SELECTED_STATE_KEY = "__codexWebGptWebProviderSelected";
const PROVIDER_QUOTA_RUNTIME_KEY = "__codexWebGptProviderQuotaRuntime";
const PROVIDER_QUOTA_SOURCE_NEEDLE = 'Rt=X(RK)&&et===`local`';
const PROVIDER_QUOTA_NEXT_NEEDLE = ",zt=";
const PROVIDER_QUOTA_SUBMIT_NEEDLE = "cn=ye||$e||ot||nt||Rt";
const PROVIDER_MODEL_RENDER_NEEDLE = "rateLimitSendBlocked:";
const PROVIDER_MODEL_SELECTED_NEEDLE = "selectedModel:";
const PROVIDER_MODEL_CHANGE_NEEDLE = ",onModelChange:";

function providerQuotaBreakpointCondition(quotaVariable) {
  return `globalThis.${PROVIDER_QUOTA_STATE_KEY}===true&&globalThis.${PROVIDER_SELECTED_STATE_KEY}===true&&(${quotaVariable}=false)`;
}

function providerSelectionBreakpointCondition(modelVariable) {
  return `(globalThis.${PROVIDER_SELECTED_STATE_KEY}=!!(${modelVariable}&&typeof ${modelVariable}.slug===\"string\"&&${modelVariable}.slug.startsWith(\"chatgpt-web/\")),false)`;
}

function sourceLocationForIndex(source, index) {
  const before = source.slice(0, index);
  const lastLineBreak = before.lastIndexOf("\n");
  return {
    lineNumber: (before.match(/\n/g) || []).length,
    columnNumber: index - lastLineBreak - 1,
  };
}

function providerQuotaBreakpointSite(source) {
  const text = String(source ?? "");
  const semanticSignature = /rateLimitSendBlockReason:([A-Za-z_$][A-Za-z0-9_$]*),rateLimitSendBlocked:([A-Za-z_$][A-Za-z0-9_$]*),rateLimitConversationSendBlocked:([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const semanticCandidates = [];
  let semanticSignatures = 0;
  let signature;
  while ((signature = semanticSignature.exec(text)) != null) {
    semanticSignatures += 1;
    const blockedInput = signature[2];
    const escapedInput = blockedInput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const windowStart = signature.index + signature[0].length;
    const aliasWindow = text.slice(windowStart, Math.min(text.length, windowStart + 8_000));
    const aliasPattern = new RegExp(`\\b([A-Za-z_$][A-Za-z0-9_$]*)=${escapedInput}!==void 0&&${escapedInput}(?=,)`);
    const alias = aliasPattern.exec(aliasWindow);
    if (!alias) continue;
    const quotaVariable = alias[1];
    const aliasIndex = windowStart + alias.index;
    const candidateIndex = aliasIndex + alias[0].length + 1;
    const gateNeedle = `||${quotaVariable}||`;
    const submitIndex = text.indexOf(gateNeedle, candidateIndex);
    if (submitIndex < 0 || submitIndex - candidateIndex > 60_000) continue;
    semanticCandidates.push({
      sourceIndex: signature.index,
      candidateIndex,
      submitIndex,
      quotaVariable,
    });
  }
  if (semanticCandidates.length > 1) {
    return { found: false, reason: "quota-source-needle-ambiguous" };
  }
  if (semanticCandidates.length === 1) {
    const candidate = semanticCandidates[0];
    return {
      found: true,
      reason: null,
      sourceKind: "semantic-rate-limit",
      quotaVariable: candidate.quotaVariable,
      sourceIndex: candidate.sourceIndex,
      candidateIndex: candidate.candidateIndex,
      candidate: sourceLocationForIndex(text, candidate.candidateIndex),
      submitIndex: candidate.submitIndex,
      submit: sourceLocationForIndex(text, candidate.submitIndex),
    };
  }

  const first = text.indexOf(PROVIDER_QUOTA_SOURCE_NEEDLE);
  if (first < 0) {
    return { found: false, reason: semanticSignatures > 0 ? "quota-source-layout-changed" : "quota-source-needle-missing" };
  }
  if (text.indexOf(PROVIDER_QUOTA_SOURCE_NEEDLE, first + PROVIDER_QUOTA_SOURCE_NEEDLE.length) >= 0) {
    return { found: false, reason: "quota-source-needle-ambiguous" };
  }
  const next = first + PROVIDER_QUOTA_SOURCE_NEEDLE.length;
  if (text.slice(next, next + PROVIDER_QUOTA_NEXT_NEEDLE.length) !== PROVIDER_QUOTA_NEXT_NEEDLE) {
    return { found: false, reason: "quota-source-layout-changed" };
  }
  const submit = text.indexOf(PROVIDER_QUOTA_SUBMIT_NEEDLE, next);
  if (submit < 0) return { found: false, reason: "quota-submit-needle-missing" };
  const candidateIndex = next + PROVIDER_QUOTA_NEXT_NEEDLE.length;
  return {
    found: true,
    reason: null,
    sourceKind: "legacy-local-provider",
    quotaVariable: "Rt",
    sourceIndex: first,
    candidateIndex,
    candidate: sourceLocationForIndex(text, candidateIndex),
    submitIndex: submit,
    submit: sourceLocationForIndex(text, submit),
  };
}

function providerAuthoritativeModelBreakpointSite(source, quotaIndexOverride = null) {
  const text = String(source ?? "");
  const renders = [];
  let render = -1;
  while ((render = text.indexOf(PROVIDER_MODEL_RENDER_NEEDLE, render + 1)) >= 0) renders.push(render);
  if (renders.length === 0) return { found: false, reason: "model-render-needle-missing" };

  const candidates = [];
  for (let index = 0; index < renders.length; index += 1) {
    const renderIndex = renders[index];
    const nextRenderIndex = renders[index + 1] ?? text.length;
    const selected = text.indexOf(PROVIDER_MODEL_SELECTED_NEEDLE, renderIndex + PROVIDER_MODEL_RENDER_NEEDLE.length);
    if (selected < 0 || selected >= nextRenderIndex) continue;
    const change = text.indexOf(PROVIDER_MODEL_CHANGE_NEEDLE, selected + PROVIDER_MODEL_SELECTED_NEEDLE.length);
    if (change < 0 || change >= nextRenderIndex || change - selected > 20_000) continue;
    const valueIndex = selected + PROVIDER_MODEL_SELECTED_NEEDLE.length;
    const modelMatch = text.slice(valueIndex, valueIndex + 128).match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (!modelMatch) continue;
    const memoBoundary = text.indexOf("}),t[", change + PROVIDER_MODEL_CHANGE_NEEDLE.length);
    if (memoBoundary < 0 || memoBoundary >= nextRenderIndex || memoBoundary - change > 20_000) continue;
    const breakpointIndex = memoBoundary + 3;
    candidates.push({ renderIndex, change, valueIndex, breakpointIndex, modelVariable: modelMatch[1] });
  }
  if (candidates.length === 0) return { found: false, reason: "model-render-layout-changed" };

  const quotaIndex = Number.isInteger(quotaIndexOverride)
    ? quotaIndexOverride
    : text.indexOf(PROVIDER_QUOTA_SOURCE_NEEDLE);
  const beforeQuota = quotaIndex < 0 ? candidates : candidates.filter(candidate => candidate.renderIndex < quotaIndex);
  const chosen = (beforeQuota.length > 0 ? beforeQuota : candidates).at(-1);
  return {
    found: true,
    reason: null,
    modelVariable: chosen.modelVariable,
    candidateCount: candidates.length,
    candidateIndex: chosen.breakpointIndex,
    candidate: sourceLocationForIndex(text, chosen.breakpointIndex),
    endIndex: chosen.breakpointIndex + 256,
    end: sourceLocationForIndex(text, Math.min(text.length, chosen.breakpointIndex + 256)),
  };
}

function providerAwareComposerQuotaRuntimeScript(enabled = true) {
  const shouldEnable = enabled === true ? "true" : "false";
  return String.raw`(() => {
    const key = '${PROVIDER_QUOTA_RUNTIME_KEY}';
    const selectedKey = '${PROVIDER_SELECTED_STATE_KEY}';
    const existing = globalThis[key];
    if (!${shouldEnable}) {
      delete globalThis[key];
      globalThis[selectedKey] = false;
      return { installed: false, restored: existing != null };
    }
    if (typeof globalThis[selectedKey] !== 'boolean') globalThis[selectedKey] = false;
    globalThis[key] = { version: 4, source: 'authoritative-model-breakpoint' };
    return { installed: true, restored: false };
  })()`;
}

function providerAuthoritativeModelStateScript() {
  return String.raw`(() => {
    const selectedKey = '${PROVIDER_SELECTED_STATE_KEY}';
    const visible = element => {
      if (!(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const roots = [...document.querySelectorAll(
      'form[data-type="unified-composer"], [data-composer-surface-variant], [data-composer-layout]'
    )].filter(root => visible(root) && root.querySelector('#prompt-textarea, [contenteditable="true"]'));
    const root = roots.find(candidate => candidate.hasAttribute('data-composer-surface-variant')) || roots.at(-1) || null;
    if (!(root instanceof Element)) {
      globalThis[selectedKey] = false;
      return { found: false, ambiguous: false, slug: null, webSelected: false, source: null };
    }
    const normalizeModel = value => {
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (value != null && typeof value === 'object') {
        if (typeof value.slug === 'string' && value.slug.trim() !== '') return value.slug.trim();
        if (typeof value.model === 'string' && value.model.trim() !== '') return value.model.trim();
      }
      return null;
    };
    const selectedModels = [];
    const pickerModels = [];
    const seenFibers = new Set();
    const elements = [root, ...root.querySelectorAll('button, #prompt-textarea, [contenteditable="true"]')];
    for (const element of elements) {
      const fiberKey = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
      let fiber = fiberKey == null ? null : element[fiberKey];
      for (let depth = 0; fiber != null && depth < 90; depth += 1, fiber = fiber.return) {
        if (seenFibers.has(fiber)) continue;
        seenFibers.add(fiber);
        const props = fiber.memoizedProps;
        if (props == null || typeof props !== 'object') continue;
        const selected = normalizeModel(props.selectedModel);
        if (selected != null) selectedModels.push(selected);
        const isModelPicker = Object.prototype.hasOwnProperty.call(props, 'modelPickerTriggerConfig')
          || Object.prototype.hasOwnProperty.call(props, 'modelOptions');
        if (isModelPicker) {
          const model = normalizeModel(props.model);
          if (model != null) pickerModels.push(model);
        }
      }
    }
    const preferred = selectedModels.length > 0 ? selectedModels : pickerModels;
    const unique = [...new Set(preferred)];
    const slug = unique.length === 1 ? unique[0] : null;
    const webSelected = typeof slug === 'string' && slug.startsWith('chatgpt-web/');
    globalThis[selectedKey] = webSelected;
    return {
      found: slug != null,
      ambiguous: unique.length > 1,
      slug,
      webSelected,
      source: selectedModels.length > 0 ? 'selectedModel' : pickerModels.length > 0 ? 'modelPicker' : null,
    };
  })()`;
}

function providerComposerQuotaRerenderScript() {
  return String.raw`(async () => {
    const visible = element => {
      if (!(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const roots = [...document.querySelectorAll(
      'form[data-type="unified-composer"], [data-composer-surface-variant], [data-composer-layout]'
    )].filter(root => visible(root) && root.querySelector('#prompt-textarea, [contenteditable="true"]'));
    const root = roots.find(candidate => candidate.hasAttribute('data-composer-surface-variant')) || roots.at(-1) || null;
    if (!(root instanceof Element)) return { dispatched: false, reason: 'composer-missing' };
    const button = [...root.querySelectorAll('button')].find(candidate => candidate instanceof HTMLButtonElement
      && (candidate.getAttribute('type') === 'submit'
        || candidate.getAttribute('data-testid') === 'send-button'
        || /^(?:send|submit)(?:\\s|$)/i.test((candidate.getAttribute('aria-label') || '').trim()))) || null;
    if (!(button instanceof HTMLButtonElement)) return { dispatched: false, reason: 'send-button-missing' };
    const fiberKey = Object.keys(button).find(key => key.startsWith('__reactFiber$'));
    let fiber = fiberKey == null ? null : button[fiberKey];
    for (let depth = 0; fiber != null && depth < 90; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props == null || typeof props !== 'object' || props.submitDisabled !== false) continue;
      let hook = fiber.memoizedState;
      for (let hookIndex = 0; hook != null && hookIndex < 300; hookIndex += 1, hook = hook.next) {
        if (!(hook.memoizedState instanceof Set) || typeof hook.queue?.dispatch !== 'function') continue;
        const beforeSize = hook.memoizedState.size;
        hook.queue.dispatch(previous => previous instanceof Set ? new Set(previous) : previous);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { dispatched: true, reason: null, depth, hookIndex, beforeSize };
      }
    }
    return { dispatched: false, reason: 'safe-rerender-hook-missing' };
  })()`;
}

function nativeQuotaStateScript(blocked) {
  return `globalThis.${PROVIDER_QUOTA_STATE_KEY}=${blocked === true ? "true" : "false"}; true`;
}

const RATE_LIMIT_GATE_PROBE_SCRIPT = String.raw`(() => {
  const roots = [...document.querySelectorAll('form[data-type="unified-composer"], [data-composer-surface-variant], [data-composer-layout]')];
  const visible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const findSendButton = composer => {
    if (!(composer instanceof Element)) return null;
    return [...composer.querySelectorAll('button')].find(candidate => candidate instanceof HTMLButtonElement
      && (candidate.getAttribute('type') === 'submit'
        || candidate.getAttribute('data-testid') === 'send-button'
        || /^(?:send|submit)(?:\s|$)/i.test((candidate.getAttribute('aria-label') || '').trim()))) || null;
  };
  const visibleRoots = roots.filter(visible);
  const managedComposer = [...visibleRoots].reverse()
    .map(candidate => ({ root: candidate, button: findSendButton(candidate) }))
    .find(candidate => candidate.button instanceof HTMLButtonElement) || null;
  const root = managedComposer?.root || visibleRoots.at(-1) || null;
  const button = managedComposer?.button || null;
  const chatGptWebSelected = globalThis.${PROVIDER_SELECTED_STATE_KEY} === true;
  const editor = root?.querySelector('#prompt-textarea, [contenteditable="true"]') || null;
  const editorText = editor instanceof HTMLElement ? (editor.innerText || editor.textContent || '') : '';
  const hasAttachments = root instanceof Element && root.querySelector('.composer-attachment-surface') != null;
  return {
    rateLimitBlocked: button instanceof HTMLButtonElement
      && (button.disabled === true || button.getAttribute('aria-disabled') === 'true'),
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
  const visibleRoots = roots.filter(visible);
  const managedComposer = [...visibleRoots].reverse()
    .map(candidate => ({
      root: candidate,
      button: [...candidate.querySelectorAll('button')].find(button => button instanceof HTMLButtonElement
        && (button.getAttribute('type') === 'submit'
          || button.getAttribute('data-testid') === 'send-button'
          || /^(?:send|submit)(?:\s|$)/i.test((button.getAttribute('aria-label') || '').trim()))) || null,
    }))
    .find(candidate => candidate.button instanceof HTMLButtonElement) || null;
  const root = managedComposer?.root || visibleRoots.at(-1) || null;
  const button = managedComposer?.button instanceof HTMLButtonElement
    && managedComposer.button.getAttribute('aria-disabled') === 'true'
    ? managedComposer.button
    : root instanceof Element
      ? [...root.querySelectorAll('button')].find(candidate => candidate instanceof HTMLButtonElement
      && candidate.getAttribute('aria-disabled') === 'true'
      && (candidate.getAttribute('type') === 'submit'
        || candidate.getAttribute('data-testid') === 'send-button'
        || /^(?:send|submit)(?:\s|$)/i.test((candidate.getAttribute('aria-label') || '').trim()))) || null
      : null;
  const stillRateLimited = button instanceof HTMLButtonElement
    && (button.disabled === true || button.getAttribute('aria-disabled') === 'true');
  if (!stillRateLimited || root.querySelector('.composer-attachment-surface') != null) return false;
  location.reload();
  return true;
})()`;

function providerAwareRateLimitGateScript(nativeQuotaBlocked) {
  const blocked = nativeQuotaBlocked === true ? "true" : "false";
  return String.raw`(() => {
    const key = '__codexWebGptProviderRateLimitGate';
    let state = globalThis[key];
    if (!state || state.version !== 7 || typeof state.sync !== 'function') {
      try { state?.observer?.disconnect?.(); } catch {}
      try { state?.disposeListeners?.(); } catch {}
      state = {
        version: 7,
        nativeQuotaBlocked: false,
        scheduled: false,
        observer: null,
        sync: null,
        schedule: null,
        disposeListeners: null,
        reactPropsOriginals: new WeakMap(),
      };
      const visible = element => {
        if (!(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const reactPropsFor = button => {
        const key = Object.keys(button).find(key => key.startsWith('__reactProps$'));
        const props = key == null ? null : button[key];
        return props != null && typeof props === 'object' ? props : null;
      };
      const reactBypassClickFor = (button, hostProps) => {
        const key = Object.keys(button).find(key => key.startsWith('__reactFiber$'));
        let fiber = key == null ? null : button[key]?.return;
        for (let depth = 0; fiber != null && depth < 8; depth += 1, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (props != null && typeof props === 'object'
            && typeof props.onClick === 'function'
            && props.onClick !== hostProps?.onClick) {
            return props.onClick;
          }
        }
        return null;
      };
      const unlockReactProps = button => {
        const props = reactPropsFor(button);
        if (props == null) return { propsUnlocked: true, clickBypassed: true };
        if (!state.reactPropsOriginals.has(props)) {
          state.reactPropsOriginals.set(props, {
            hadDisabled: Object.prototype.hasOwnProperty.call(props, 'disabled'),
            disabled: props.disabled,
            hadAriaDisabled: Object.prototype.hasOwnProperty.call(props, 'aria-disabled'),
            ariaDisabled: props['aria-disabled'],
            hadOnClick: Object.prototype.hasOwnProperty.call(props, 'onClick'),
            onClick: props.onClick,
          });
        }
        const bypassOnClick = reactBypassClickFor(button, props);
        try { props.disabled = false; } catch {}
        try { props['aria-disabled'] = false; } catch {}
        if (typeof bypassOnClick === 'function') {
          try { props.onClick = bypassOnClick; } catch {}
        }
        return {
          propsUnlocked: props.disabled !== true
            && props['aria-disabled'] !== true
            && props['aria-disabled'] !== 'true',
          clickBypassed: typeof props.onClick !== 'function'
            || typeof bypassOnClick === 'function' && props.onClick === bypassOnClick,
        };
      };
      const restoreReactProps = button => {
        const props = reactPropsFor(button);
        if (props == null) return;
        const original = state.reactPropsOriginals.get(props);
        if (original == null) return;
        try {
          if (original.hadDisabled) props.disabled = original.disabled;
          else delete props.disabled;
          if (original.hadAriaDisabled) props['aria-disabled'] = original.ariaDisabled;
          else delete props['aria-disabled'];
          if (original.hadOnClick) props.onClick = original.onClick;
          else delete props.onClick;
        } catch {}
        state.reactPropsOriginals.delete(props);
      };
      state.sync = () => {
        const roots = [...document.querySelectorAll('form[data-type="unified-composer"], [data-composer-surface-variant], [data-composer-layout]')];
        const visibleRoots = roots.filter(visible);
        const managedComposer = [...visibleRoots].reverse()
          .map(candidate => ({
            root: candidate,
            button: [...candidate.querySelectorAll('button')].find(button => button instanceof HTMLButtonElement
              && (button.getAttribute('type') === 'submit'
                || button.getAttribute('data-testid') === 'send-button'
                || /^(?:send|submit)(?:\s|$)/i.test((button.getAttribute('aria-label') || '').trim()))) || null,
          }))
          .find(candidate => candidate.button instanceof HTMLButtonElement) || null;
        const root = managedComposer?.root || visibleRoots.at(-1) || null;
        const button = managedComposer?.button || (root instanceof Element
          ? [...root.querySelectorAll('button')].find(candidate => candidate instanceof HTMLButtonElement
            && (candidate.getAttribute('type') === 'submit'
              || candidate.getAttribute('data-testid') === 'send-button'
              || /^(?:send|submit)(?:\s|$)/i.test((candidate.getAttribute('aria-label') || '').trim()))) || null
          : null);
        if (!(root instanceof Element) || !(button instanceof HTMLButtonElement)) {
          return { managed: false, unlocked: false, selected: false, sendable: false };
        }
        const selected = globalThis.${PROVIDER_SELECTED_STATE_KEY} === true;
        const editor = root.querySelector('#prompt-textarea, [contenteditable="true"]');
        const editorText = editor instanceof HTMLElement ? (editor.innerText || editor.textContent || '') : '';
        const hasAttachments = root.querySelector('.composer-attachment-surface') != null;
        const sendable = editorText.trim().length > 0 || hasAttachments;
        const marked = button.getAttribute('data-cw-chatgpt-web-quota-unlock') === 'true';
        const shouldUnlock = state.nativeQuotaBlocked === true
          && selected
          && sendable;
        let reactUnlocked = false;
        let reactClickBypassed = false;
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
            button.setAttribute('data-cw-chatgpt-web-quota-unlock', 'true');
          }
          if (button.disabled === true) button.disabled = false;
          if (button.getAttribute('aria-disabled') !== 'false') button.setAttribute('aria-disabled', 'false');
          const reactGate = unlockReactProps(button);
          reactUnlocked = reactGate.propsUnlocked;
          reactClickBypassed = reactGate.clickBypassed;
        } else if (!shouldUnlock && marked) {
          const originalDisabled = button.getAttribute('data-cw-chatgpt-web-quota-original-disabled') === 'true';
          if (button.disabled !== originalDisabled) button.disabled = originalDisabled;
          const originalAriaDisabled = button.getAttribute('data-cw-chatgpt-web-quota-original-aria-disabled');
          if (originalAriaDisabled === '__null__') {
            if (button.hasAttribute('aria-disabled')) button.removeAttribute('aria-disabled');
          } else if (originalAriaDisabled != null && button.getAttribute('aria-disabled') !== originalAriaDisabled) {
            button.setAttribute('aria-disabled', originalAriaDisabled);
          }
          button.removeAttribute('data-cw-chatgpt-web-quota-unlock');
          button.removeAttribute('data-cw-chatgpt-web-quota-original-disabled');
          button.removeAttribute('data-cw-chatgpt-web-quota-original-aria-disabled');
          restoreReactProps(button);
        } else {
          restoreReactProps(button);
        }
        return {
          managed: button.getAttribute('data-cw-chatgpt-web-quota-unlock') === 'true',
          unlocked: button.disabled === false
            && button.getAttribute('aria-disabled') !== 'true'
            && (!shouldUnlock || reactUnlocked && reactClickBypassed),
          reactUnlocked,
          reactClickBypassed,
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
      const gateScope = 'form[data-type="unified-composer"], [data-composer-surface-variant], [data-composer-layout], button[aria-haspopup="menu"]';
      const mutationTouchesGate = mutation => {
        const target = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
        if (target?.matches?.(gateScope) || target?.closest?.(gateScope)) return true;
        for (const node of mutation.addedNodes || []) {
          if (node?.nodeType !== 1) continue;
          if (node.matches?.(gateScope) || node.closest?.(gateScope) || node.querySelector?.(gateScope)) return true;
        }
        return false;
      };
      state.observer = new MutationObserver(records => {
        if (records.some(mutationTouchesGate)) state.schedule();
      });
      state.observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-disabled', 'disabled', 'aria-haspopup', 'aria-label'],
      });
      const onComposerInput = () => state.schedule();
      document.addEventListener?.('input', onComposerInput, true);
      document.addEventListener?.('change', onComposerInput, true);
      state.disposeListeners = () => {
        document.removeEventListener?.('input', onComposerInput, true);
        document.removeEventListener?.('change', onComposerInput, true);
      };
      globalThis[key] = state;
    }
    state.nativeQuotaBlocked = ${blocked};
    const result = state.sync();
    if (state.nativeQuotaBlocked !== true) {
      try { state.observer?.disconnect?.(); } catch {}
      try { state.disposeListeners?.(); } catch {}
      delete globalThis[key];
    }
    return result;
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
    this.eventListeners = new Map();
    this.parsedScripts = new Map();
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
        if (this.socket === socket) {
          this.socket = null;
          this.parsedScripts.clear();
        }
        reject(error instanceof Error ? error : new Error("Official Codex CDP connection failed"));
      };
      socket.onopen = () => {
        this.socket = socket;
        resolve();
      };
      socket.onerror = () => fail(new Error("Official Codex CDP connection failed"));
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
          this.parsedScripts.clear();
        }
        const error = new Error("Official Codex CDP target closed");
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      };
      socket.onmessage = event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (typeof message?.method === "string") {
          if (message.method === "Debugger.globalObjectCleared") this.parsedScripts.clear();
          if (message.method === "Debugger.scriptParsed" && typeof message.params?.scriptId === "string") {
            this.parsedScripts.set(message.params.scriptId, message.params);
          }
          const listeners = this.eventListeners.get(message.method);
          if (listeners) {
            for (const listener of [...listeners]) {
              try { listener(message.params ?? {}, message); } catch {}
            }
          }
          return;
        }
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

  async sendCommand(method, params = {}) {
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
        method,
        params,
      }));
    });
    return result;
  }

  async executeJavaScript(expression) {
    const result = await this.sendCommand("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "JavaScript evaluation failed";
      throw new Error(description);
    }
    return result?.result?.value;
  }

  onEvent(method, listener) {
    if (typeof method !== "string" || typeof listener !== "function") return () => {};
    let listeners = this.eventListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(method);
    };
  }

  knownScripts() {
    return [...this.parsedScripts.values()];
  }

  async refreshKnownScripts() {
    // Debugger.enable on an already enabled CDP session does not replay scriptParsed.
    // Disable first so a page reload or a reconnected socket cannot leave the old
    // app-primary script alongside the current one in our script index.
    await this.sendCommand("Debugger.disable");
    this.parsedScripts.clear();
    await this.sendCommand("Debugger.enable");
    await this.executeJavaScript("0");
    return this.knownScripts();
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
    this.eventListeners.clear();
    this.parsedScripts.clear();
    try { this.socket?.close(); } catch {}
    this.socket = null;
  }
}

async function installProviderAwareComposerQuotaPatch(contents) {
  const primaryScripts = (await contents.refreshKnownScripts()).filter(script => (
    typeof script?.url === "string"
    && /^app:\/\/-\/assets\/app-primary-[^/?]+\.js(?:\?.*)?$/.test(script.url)
  ));
  if (primaryScripts.length !== 1) {
    return { applied: false, reason: primaryScripts.length === 0 ? "app-primary-script-missing" : "app-primary-script-ambiguous" };
  }
  const script = primaryScripts[0];
  const sourceResult = await contents.sendCommand("Debugger.getScriptSource", { scriptId: script.scriptId });
  const source = String(sourceResult?.scriptSource ?? "");
  const site = providerQuotaBreakpointSite(source);
  if (!site.found) return { applied: false, reason: site.reason };
  const modelSite = providerAuthoritativeModelBreakpointSite(source, site.sourceIndex);
  if (!modelSite.found) return { applied: false, reason: modelSite.reason };
  await contents.executeJavaScript(providerAwareComposerQuotaRuntimeScript(true));
  const initialModelState = await contents.executeJavaScript(providerAuthoritativeModelStateScript());

  const modelBreakpoint = await contents.sendCommand("Debugger.setBreakpointByUrl", {
    url: script.url,
    lineNumber: modelSite.candidate.lineNumber,
    columnNumber: modelSite.candidate.columnNumber,
    condition: providerSelectionBreakpointCondition(modelSite.modelVariable),
  });
  if (typeof modelBreakpoint?.breakpointId !== "string") {
    return { applied: false, reason: "model-breakpoint-install-failed" };
  }

  const possibleResult = await contents.sendCommand("Debugger.getPossibleBreakpoints", {
    start: { scriptId: script.scriptId, ...site.candidate },
    end: { scriptId: script.scriptId, ...site.submit },
    restrictToFunction: false,
  });
  const location = (possibleResult?.locations || []).find(candidate => (
    Number.isInteger(candidate?.lineNumber)
    && Number.isInteger(candidate?.columnNumber)
    && (candidate.lineNumber > site.candidate.lineNumber
      || candidate.lineNumber === site.candidate.lineNumber && candidate.columnNumber >= site.candidate.columnNumber)
    && (candidate.lineNumber < site.submit.lineNumber
      || candidate.lineNumber === site.submit.lineNumber && candidate.columnNumber < site.submit.columnNumber)
  ));
  if (!location) {
    await contents.sendCommand("Debugger.removeBreakpoint", { breakpointId: modelBreakpoint.breakpointId }).catch(() => {});
    return { applied: false, reason: "quota-breakpoint-location-missing" };
  }
  const breakpoint = await contents.sendCommand("Debugger.setBreakpointByUrl", {
    url: script.url,
    lineNumber: location.lineNumber,
    columnNumber: location.columnNumber,
    condition: providerQuotaBreakpointCondition(site.quotaVariable),
  });
  if (typeof breakpoint?.breakpointId !== "string") {
    await contents.sendCommand("Debugger.removeBreakpoint", { breakpointId: modelBreakpoint.breakpointId }).catch(() => {});
    return { applied: false, reason: "quota-breakpoint-install-failed" };
  }
  const rerender = initialModelState?.webSelected === true
    ? await contents.executeJavaScript(providerComposerQuotaRerenderScript())
    : { dispatched: false, reason: "web-model-not-selected" };
  return {
    applied: true,
    reason: null,
    breakpointId: breakpoint.breakpointId,
    breakpointIds: [modelBreakpoint.breakpointId, breakpoint.breakpointId],
    modelBreakpointId: modelBreakpoint.breakpointId,
    modelVariable: modelSite.modelVariable,
    quotaVariable: site.quotaVariable,
    quotaSourceKind: site.sourceKind,
    initialModelState,
    rerender,
    url: script.url,
    location: { lineNumber: location.lineNumber, columnNumber: location.columnNumber },
    modelLocation: { lineNumber: modelSite.candidate.lineNumber, columnNumber: modelSite.candidate.columnNumber },
  };
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
  let wallpapersEnabled = false;
  let providerGateEnabled = false;
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

  const integrationActive = () => wallpapersEnabled || providerGateEnabled;

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
        entry.rateLimitBlockedSince = null;
        return false;
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
      onStatus({ enabled: wallpapersEnabled, status, restartRequired, error: lastError, ...patch });
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
    if (!integrationActive() || !endpoint || refreshInFlight) return 0;
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
            providerQuotaPatchApplied: false,
            providerQuotaPatchAttemptedAt: 0,
            providerQuotaPatchUnavailableReason: null,
            providerQuotaBreakpointIds: [],
            providerQuotaBreakpointUrl: null,
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
            if (entry.providerQuotaBreakpointIds?.length) {
              await Promise.all(entry.providerQuotaBreakpointIds.map(breakpointId => (
                entry.contents.sendCommand("Debugger.removeBreakpoint", { breakpointId }).catch(() => {})
              )));
              entry.providerQuotaBreakpointIds = [];
              entry.providerQuotaBreakpointUrl = null;
            }
            const result = wallpapersEnabled
              ? await wallpaperManager.install(entry.contents)
              : { libraryCount: 0, transferred: 0, injected: false };
            entry.generation = generation;
            entry.providerQuotaPatchApplied = false;
            entry.providerQuotaPatchAttemptedAt = 0;
            entry.providerQuotaPatchUnavailableReason = null;
            if (wallpapersEnabled) {
              applied += 1;
              logger.info("wallpapers.official_codex_applied", {
                targetId: target.id,
                libraryCount: result?.libraryCount ?? 0,
                transferred: result?.transferred ?? 0,
                injected: result?.injected === true,
              });
            }
          }
          if (providerGateEnabled) {
            const checkedAt = now();
            if (!entry.providerQuotaPatchApplied
              && checkedAt - entry.providerQuotaPatchAttemptedAt >= 5_000) {
              entry.providerQuotaPatchAttemptedAt = checkedAt;
              const patch = await installProviderAwareComposerQuotaPatch(entry.contents);
              if (patch.applied) {
                entry.providerQuotaPatchApplied = true;
                entry.providerQuotaPatchUnavailableReason = null;
                entry.providerQuotaBreakpointIds = patch.breakpointIds ?? [patch.breakpointId].filter(Boolean);
                entry.providerQuotaBreakpointUrl = patch.url;
                logger.info("wallpapers.official_codex_provider_quota_state_patch_applied", {
                  targetId: target.id,
                  url: patch.url,
                  lineNumber: patch.location?.lineNumber ?? null,
                  columnNumber: patch.location?.columnNumber ?? null,
                  modelLineNumber: patch.modelLocation?.lineNumber ?? null,
                  modelColumnNumber: patch.modelLocation?.columnNumber ?? null,
                  modelVariable: patch.modelVariable ?? null,
                });
              } else {
                if (entry.providerQuotaPatchUnavailableReason !== patch.reason) {
                  entry.providerQuotaPatchUnavailableReason = patch.reason;
                  logger.warn("wallpapers.official_codex_provider_quota_state_patch_unavailable", {
                    targetId: target.id,
                    reason: patch.reason,
                  });
                }
              }
            }
            await readRateLimitUsage(entry, target.id, checkedAt);
            await entry.contents.executeJavaScript(nativeQuotaStateScript(entry.nativeQuotaBlocked === true));
            await entry.contents.executeJavaScript(providerAuthoritativeModelStateScript());
            await maybeRecoverStaleRateLimit(entry, target.id);
          } else {
            await entry.contents.executeJavaScript(nativeQuotaStateScript(false));
            if (entry.providerGateActive === true) {
              await entry.contents.executeJavaScript(providerAwareRateLimitGateScript(false));
              entry.providerGateActive = false;
            }
          }
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
      if (endpointFailures >= 3 && integrationActive() && identity) {
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
    if (integrationActive() && endpoint && !refreshTimer) {
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
    if (!integrationActive()) return { enabled: wallpapersEnabled, restartRequired: false, applied: 0, status, error: lastError };
    const nextEndpoint = await waitForEndpoint(nextIdentity, port, { validateEndpoint });
    if (!nextEndpoint) {
      beginRestartWait(nextIdentity);
      publish({ status: "restart-required", restartRequired: true, error: null });
      return { enabled: wallpapersEnabled, restartRequired: true, applied: 0, status, error: lastError };
    }
    writeEndpoint(nextEndpoint);
    const applied = await startRefresh(nextIdentity, nextEndpoint);
    return { enabled: wallpapersEnabled, restartRequired: false, applied, status, error: lastError };
  };

  function beginRestartWait(nextIdentity, baselineProcesses = null) {
    identity = nextIdentity;
    if (!integrationActive() || restartTimer) return;
    restartBaseline = processIdentitySet(baselineProcesses);
    restartTimer = setInterval(async () => {
      if (!integrationActive() || restartTimer === null) return;
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
        if (integrationActive() && restartTimer === null) {
          beginRestartWait(nextIdentity);
        }
      }
    }, restartPollIntervalMs);
    restartTimer.unref?.();
  }

  async function prepareExternalRestart() {
    if (!integrationActive()) return null;
    const nextIdentity = identity || await resolveIdentity();
    stopRestartWait();
    stopRefresh();
    identity = nextIdentity;
    publish({ status: "restarting", restartRequired: false, error: null });
    return { identity: nextIdentity };
  }

  async function resumeExternalRestart() {
    if (!integrationActive()) return null;
    const nextIdentity = identity || await resolveIdentity();
    return launchAndAttach(nextIdentity);
  }

  async function abortExternalRestart() {
    if (!integrationActive()) return null;
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
      wallpapersEnabled = false;
      stopRestartWait();
      stopRefresh();
      publish({ status: "disabled", restartRequired: false, error: null });
      return { enabled: false, restartRequired: false, applied: 0 };
    }
    if (!next) {
      wallpapersEnabled = false;
      if (!providerGateEnabled) stopRestartWait();
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
      if (!providerGateEnabled) stopRefresh();
      publish({ status: "disabled", restartRequired: false, error: null });
      return { enabled: false, restartRequired: false, applied: 0, status, error: lastError };
    }

    wallpapersEnabled = true;
    for (const entry of sessions.values()) entry.generation = null;
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

  const setProviderGateEnabledNow = async next => {
    if (platform !== "win32") {
      providerGateEnabled = false;
      if (!wallpapersEnabled) {
        stopRestartWait();
        stopRefresh();
      }
      return { enabled: false, restartRequired: false, applied: 0 };
    }

    if (!next) {
      providerGateEnabled = false;
      await Promise.all([...sessions.values()].map(async entry => {
        if (entry.contents.isDestroyed?.()) return;
        await entry.contents.executeJavaScript(nativeQuotaStateScript(false)).catch(() => {});
        await entry.contents.executeJavaScript(providerAwareRateLimitGateScript(false)).catch(() => {});
        await entry.contents.executeJavaScript(providerAwareComposerQuotaRuntimeScript(false)).catch(() => {});
        if (entry.providerQuotaBreakpointIds?.length) {
          await Promise.all(entry.providerQuotaBreakpointIds.map(breakpointId => (
            entry.contents.sendCommand("Debugger.removeBreakpoint", { breakpointId }).catch(() => {})
          )));
        }
        entry.providerQuotaPatchApplied = false;
        entry.providerQuotaBreakpointIds = [];
        entry.providerQuotaBreakpointUrl = null;
        entry.providerGateActive = false;
      }));
      if (!wallpapersEnabled) {
        stopRestartWait();
        stopRefresh();
      }
      return { enabled: false, restartRequired: false, applied: 0 };
    }

    providerGateEnabled = true;
    identity = await resolveIdentity();
    const stored = await attachStoredEndpoint(identity);
    if (stored) {
      const applied = await startRefresh(identity, stored);
      return { enabled: true, restartRequired: false, applied, status, error: lastError };
    }
    const processes = await listProcesses(identity);
    if (processes.length > 0) {
      beginRestartWait(identity, processes);
      return { enabled: true, restartRequired: true, applied: 0, status: "restart-required", error: null };
    }
    const result = await launchAndAttach(identity);
    return { ...result, enabled: true };
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
    setProviderGateEnabled(next) {
      const requested = next === true;
      operation = operation.catch(() => {}).then(() => setProviderGateEnabledNow(requested));
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
  installProviderAwareComposerQuotaPatch,
  providerQuotaBreakpointSite,
  providerAwareComposerQuotaRuntimeScript,
  providerAuthoritativeModelStateScript,
  providerComposerQuotaRerenderScript,
  providerAwareRateLimitGateScript,
  resolveOfficialCodexIdentity,
  usageAllowsRateLimitRecovery,
  usageShowsNativeQuotaExhaustion,
  validateOfficialEndpoint,
  waitForOfficialEndpoint,
};
