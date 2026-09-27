import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MetalFx, isMetalFxSupported, useMetalBend } from "metal-fx";

type MetalSendOptions = {
  paused?: boolean;
  strength?: number;
  preset?: "chromatic" | "silver" | "gold";
  reflectionTargets?: HTMLElement[];
};

type MetalSendController = {
  supported: boolean;
  update(options?: MetalSendOptions): void;
  dispose(): void;
};

type MetalSendGlobal = {
  mount(target: HTMLButtonElement, options?: MetalSendOptions): MetalSendController;
  supported(): boolean;
};

declare global {
  interface Window {
    __CODEX_WALLPAPERS_METAL_SEND__?: MetalSendGlobal;
  }
}

function clampStrength(value: number | undefined) {
  if (!Number.isFinite(value)) return 0.94;
  return Math.max(0, Math.min(1, Number(value)));
}

function MetalSendEffect({ target, options }: { target: HTMLButtonElement; options: MetalSendOptions }) {
  const metalRef = useRef<HTMLDivElement>(null);
  const [disabled, setDisabled] = useState(Boolean(target.disabled || target.getAttribute("aria-disabled") === "true"));
  const reflectionTargets = useMemo(
    () => (options.reflectionTargets ?? [])
      .filter(element => element instanceof HTMLElement && element.isConnected && element !== target)
      .map(element => ({ current: element } as React.RefObject<HTMLElement | null>)),
    [options.reflectionTargets, target],
  );
  useMetalBend(metalRef);

  useEffect(() => {
    const refresh = () => setDisabled(Boolean(target.disabled || target.getAttribute("aria-disabled") === "true"));
    const observer = new MutationObserver(refresh);
    observer.observe(target, { attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
    refresh();
    return () => observer.disconnect();
  }, [target]);

  return (
    <MetalFx
      ref={metalRef}
      variant="circle"
      preset={options.preset ?? "chromatic"}
      theme="dark"
      strength={disabled ? Math.min(0.42, clampStrength(options.strength)) : clampStrength(options.strength)}
      paused={Boolean(options.paused || disabled)}
      innerShadow
      glowGain={1.2}
      reflectionTargets={reflectionTargets}
      normalizeHostStyles={false}
      aria-hidden="true"
      style={{
        // MetalFx is inline-flex by default. Inside the absolutely-positioned
        // button host that makes it participate in the button's inherited line
        // box/baseline, which can shift the shader ring a few pixels away from
        // the native send-button circle. Pin the renderer to the host instead.
        position: "absolute",
        inset: 0,
        display: "flex",
        width: "100%",
        height: "100%",
        minWidth: "100%",
        minHeight: "100%",
        margin: 0,
        boxSizing: "border-box",
        background: "transparent",
        pointerEvents: "none",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          borderRadius: "9999px",
          background: "transparent",
          pointerEvents: "none",
        }}
      />
    </MetalFx>
  );
}

function supported() {
  try {
    return isMetalFxSupported();
  } catch {
    return false;
  }
}

function mount(target: HTMLButtonElement, initial: MetalSendOptions = {}): MetalSendController {
  if (!(target instanceof HTMLElement) || target.tagName !== "BUTTON" || !supported()) {
    return { supported: false, update() {}, dispose() {} };
  }

  const host = document.createElement("div");
  host.dataset.cwMetalSend = "true";
  host.setAttribute("aria-hidden", "true");
  const originalStyle = {
    position: target.style.position,
    overflow: target.style.overflow,
    isolation: target.style.isolation,
  };
  const originalMarker = target.getAttribute("data-cw-metal-send-target");
  const computedTarget = getComputedStyle(target);
  if (computedTarget.position === "static") target.style.position = "relative";
  target.style.overflow = "visible";
  target.style.isolation = "isolate";
  target.setAttribute("data-cw-metal-send-target", "true");
  host.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    "right:0",
    "bottom:0",
    "width:100%",
    "height:100%",
    "z-index:2",
    "pointer-events:none",
    "overflow:visible",
    "contain:layout style",
    "display:block",
    "line-height:0",
  ].join(";");
  target.appendChild(host);

  let options = { ...initial };
  let disposed = false;
  let frame = 0;
  let root: Root | null = createRoot(host);

  const render = () => root?.render(<MetalSendEffect target={target} options={options} />);
  const sync = () => {
    frame = 0;
    if (disposed) return;
    if (!target.isConnected) {
      host.style.display = "none";
      return;
    }
    if (host.parentElement !== target) target.appendChild(host);
    const rect = target.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      host.style.display = "none";
      return;
    }
    host.style.display = "block";
    host.style.borderRadius = getComputedStyle(target).borderRadius || "9999px";
  };
  const queueSync = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };

  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(queueSync) : null;
  resizeObserver?.observe(target);
  const mutationObserver = new MutationObserver(queueSync);
  mutationObserver.observe(target, { childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
  window.addEventListener("resize", queueSync, { passive: true });
  render();
  queueSync();

  return {
    supported: true,
    update(next = {}) {
      if (disposed) return;
      if (next.reflectionTargets && options.reflectionTargets
        && next.reflectionTargets.length === options.reflectionTargets.length
        && next.reflectionTargets.every((element, index) => element === options.reflectionTargets?.[index])) {
        next = { ...next, reflectionTargets: options.reflectionTargets };
      }
      options = { ...options, ...next };
      render();
      queueSync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", queueSync);
      root?.unmount();
      root = null;
      host.remove();
      target.style.position = originalStyle.position;
      target.style.overflow = originalStyle.overflow;
      target.style.isolation = originalStyle.isolation;
      if (originalMarker === null) target.removeAttribute("data-cw-metal-send-target");
      else target.setAttribute("data-cw-metal-send-target", originalMarker);
    },
  };
}

window.__CODEX_WALLPAPERS_METAL_SEND__ = { mount, supported };
