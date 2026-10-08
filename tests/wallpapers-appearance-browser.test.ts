import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("Wallpapers clears the current thread footer without clearing the composer or unrelated surfaces", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      .bg-surface { background: rgb(24, 24, 24); }
      .absolute { position: absolute; }
      .pointer-events-none { pointer-events: none; }
      [data-thread-scroll-footer] { width: 100%; height: 120px; }
      #composer { width: 736px; height: 98px; background: rgb(24, 24, 24); }
    </style><main data-app-shell-main-surface>
      <div data-thread-scroll-footer class="bg-surface">
        <div id="backdrop" class="pointer-events-none absolute bg-surface"></div>
        <div data-codex-composer-root data-composer-placement="thread">
          <div id="composer" data-composer-layout="multiline" data-composer-surface-variant="default"><textarea></textarea></div>
        </div>
      </div>
      <div id="unrelated" class="pointer-events-none absolute bg-surface"></div>
    </main>`);
    await page.addStyleTag({ content: readFileSync(new URL("../launcher/wallpapers/appearance.css", import.meta.url), "utf8") });
    const backgrounds = () => page.evaluate(() => ({
      footer: getComputedStyle(document.querySelector("[data-thread-scroll-footer]")!).backgroundColor,
      backdrop: getComputedStyle(document.getElementById("backdrop")!).backgroundColor,
      composer: getComputedStyle(document.getElementById("composer")!).backgroundColor,
      unrelated: getComputedStyle(document.getElementById("unrelated")!).backgroundColor,
    }));
    expect(await backgrounds()).toEqual({ footer: "rgb(24, 24, 24)", backdrop: "rgb(24, 24, 24)", composer: "rgb(24, 24, 24)", unrelated: "rgb(24, 24, 24)" });
    await page.evaluate(() => {
      document.documentElement.style.cssText = "--cw-surface:#121316;--cw-composer-opacity:98%;--cw-composer-radius:18px";
      document.documentElement.classList.add("cw-active");
    });
    const active = await backgrounds();
    expect(active.footer).toBe("rgba(0, 0, 0, 0)");
    expect(active.backdrop).toBe("rgba(0, 0, 0, 0)");
    expect(active.composer).not.toBe("rgba(0, 0, 0, 0)");
    expect(active.unrelated).toBe("rgb(24, 24, 24)");
    await page.locator("textarea").fill("Typing still works");
    expect(await page.locator("textarea").inputValue()).toBe("Typing still works");
    await page.evaluate(() => document.documentElement.classList.remove("cw-active"));
    expect(await backgrounds()).toEqual({ footer: "rgb(24, 24, 24)", backdrop: "rgb(24, 24, 24)", composer: "rgb(24, 24, 24)", unrelated: "rgb(24, 24, 24)" });
  } finally { await browser.close(); }
}, 30_000);
