const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const domino = require("@mixmark-io/domino");
const {
  createWallpaperManager,
  readWallpaperLibrary,
  safeLibraryPath,
} = require("../electron/wallpapers.cjs");

const isShellReadyScript = script => script.includes("main[data-app-shell-main-surface]")
  && script.includes("main#main")
  && script.includes("form[data-type=\"unified-composer\"]")
  && script.includes("#prompt-textarea");

class FakeContents {
  constructor() {
    this.calls = [];
    this.installed = false;
    this.disposed = false;
    this.pageEnabled = true;
  }

  isDestroyed() {
    return false;
  }

  async executeJavaScript(script) {
    this.calls.push(script);
    if (script.trimStart().startsWith("// Executed once per Codex window")) {
      this.installed = true;
      return "installed";
    }
    if (isShellReadyScript(script)) return true;
    if (script === "Boolean(window.__CODEX_WALLPAPERS_PUBLIC__)") return this.installed;
    if (script.includes("window.__CODEX_WALLPAPERS_PUBLIC__?.dispose()")) {
      this.disposed = true;
      this.installed = false;
      return undefined;
    }
    if (script.includes("window.__CODEX_WALLPAPERS_PUBLIC__.ids()")) return [];
    if (script.includes(".ready()")) return { count: 1, enabled: this.pageEnabled };
    if (script.includes(".setEnabled(true)")) {
      this.pageEnabled = true;
      return { count: 1, enabled: true };
    }
    return undefined;
  }
}

class DelayedShellContents extends FakeContents {
  constructor(shellReadyAfter) {
    super();
    this.shellReadyAfter = shellReadyAfter;
    this.shellChecks = 0;
  }

  async executeJavaScript(script, ...args) {
    if (script.trimStart().startsWith("// Executed once per Codex window")) {
      return super.executeJavaScript(script, ...args);
    }
    if (isShellReadyScript(script)) {
      this.calls.push(script);
      this.shellChecks += 1;
      return this.shellChecks > this.shellReadyAfter;
    }
    return super.executeJavaScript(script, ...args);
  }
}

function runWallpaperRuntime(markup, shellMarkup = '<main data-app-shell-main-surface></main>') {
  const window = domino.createWindow(`<!doctype html><html><head></head><body>${shellMarkup}${markup}</body></html>`);
  const { document } = window;
  const elementPrototype = window.Element.prototype;
  if (!Object.getOwnPropertyDescriptor(elementPrototype, "dataset")) {
    Object.defineProperty(elementPrototype, "dataset", {
      configurable: true,
      get() {
        const element = this;
        const attributeName = key => `data-${String(key).replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}`;
        return new Proxy({}, {
          get(_target, key) {
            if (typeof key !== "string") return undefined;
            return element.getAttribute(attributeName(key)) ?? undefined;
          },
          set(_target, key, value) {
            element.setAttribute(attributeName(key), String(value));
            return true;
          },
        });
      },
    });
  }
  elementPrototype.attachShadow = function attachShadow() { return this; };
  elementPrototype.getElementById = function getElementById(id) { return this.querySelector(`#${id}`); };
  elementPrototype.append = function append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === "string" ? document.createTextNode(node) : node);
  };
  elementPrototype.prepend = function prepend(...nodes) {
    for (const node of nodes.slice().reverse()) this.insertBefore(typeof node === "string" ? document.createTextNode(node) : node, this.firstChild);
  };
  const htmlCollectionPrototype = Object.getPrototypeOf(document.body.children);
  if (!htmlCollectionPrototype[Symbol.iterator]) {
    Object.defineProperty(htmlCollectionPrototype, Symbol.iterator, {
      configurable: true,
      value: Array.prototype[Symbol.iterator],
    });
  }

  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const mediaQuery = { matches: false, addEventListener() {}, removeEventListener() {} };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  const runtime = fs.readFileSync(path.join(__dirname, "../wallpapers/runtime.js"), "utf8");
  const execute = new Function(
    "window",
    "document",
    "localStorage",
    "matchMedia",
    "MutationObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    `${runtime}\n({ appearanceCSS: "", modalCSS: "" });`,
  );
  execute(window, document, localStorage, () => mediaQuery, MutationObserver, () => 1, () => {});
  return { window, document };
}

function fixtureLibrary(root) {
  const media = Buffer.from("a small wallpaper");
  const preview = Buffer.from("preview");
  const hash = crypto.createHash("sha256").update(media).digest("hex");
  const id = hash.slice(0, 24);
  fs.mkdirSync(path.join(root, "media"), { recursive: true });
  fs.mkdirSync(path.join(root, "previews"), { recursive: true });
  fs.writeFileSync(path.join(root, `media/${id}.png`), media);
  fs.writeFileSync(path.join(root, `previews/${id}.jpg`), preview);
  fs.writeFileSync(path.join(root, "library.json"), JSON.stringify({
    schema: 1,
    items: [{
      id,
      title: "Test wallpaper",
      kind: "image",
      mime: "image/png",
      file: `media/${id}.png`,
      preview: `previews/${id}.jpg`,
      size: media.length,
      sha256: hash,
      width: 640,
      height: 360,
      duration: null,
      palette: { accent: "#ffffff" },
    }],
  }, null, 2));
}

test("Codex Wallpapers accepts the shared empty library and rejects traversal paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-wallpapers-empty-"));
  try {
    assert.deepEqual(await readWallpaperLibrary(root), { schema: 1, items: [] });
    assert.equal(safeLibraryPath(root, "media/example.png"), path.join(root, "media", "example.png"));
    assert.throws(() => safeLibraryPath(root, "../outside.png"), /library path/);
    assert.throws(() => safeLibraryPath(root, "media\\outside.png"), /library path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex Wallpapers injects an English Wallpapers row into a structural profile menu without menu roles", () => {
  const { window, document } = runWallpaperRuntime(`
    <button data-testid="profile-button" aria-label="Abrir menú de perfil" aria-expanded="true">Profile</button>
    <section data-state="open" class="profile-popover">
      <div class="profile-row"><button id="settings" data-testid="settings-row"><span>Configuración</span></button></div>
      <div class="profile-row"><a id="logout"><span>Cerrar sesión</span></a></div>
    </section>
  `);

  const status = window.__CODEX_WALLPAPERS_PUBLIC__.status();
  assert.equal(status.profileMenu, true, `expected the structural profile menu to be detected: ${JSON.stringify(status)}`);
  const injected = document.querySelector("[data-cw-menu]");
  assert.ok(injected, "expected a wallpaper profile-menu entry");
  assert.equal(injected.textContent.trim(), "Wallpapers");
  assert.equal(injected.querySelector("[data-testid]") == null, true, "cloned ChatGPT test ids must not be duplicated");
  assert.equal(status.profileButton, true);
});

test("Codex Wallpapers matches the official app profile menu trigger and rows", () => {
  const { window, document } = runWallpaperRuntime(`
    <button id="profile-trigger" aria-label="Open profile menu" aria-haspopup="menu" aria-expanded="true" aria-controls="profile-menu" data-state="open"><span>James O</span></button>
    <div id="profile-menu" role="menu" data-state="open" data-radix-menu-content aria-labelledby="profile-trigger" class="profile-menu">
      <div class="profile-menu-items">
        <div role="menuitem" tabindex="-1" data-radix-collection-item><span>Usage remaining</span><span>7%</span></div>
        <div role="menuitem" tabindex="-1" data-radix-collection-item><span>Show pet</span><span>Alt+Win+P</span></div>
        <div role="menuitem" tabindex="-1" data-radix-collection-item><span>Invite a friend</span></div>
        <div role="menuitem" tabindex="-1" data-radix-collection-item><span class="flex-1 min-w-0 truncate">Settings</span><span class="ms-2 shrink-0 text-xs">Ctrl+,</span></div>
        <div role="menuitem" tabindex="-1" data-radix-collection-item><span>Log out</span></div>
      </div>
    </div>
  `);

  const status = window.__CODEX_WALLPAPERS_PUBLIC__.status();
  assert.equal(status.profileMenu, true, `expected the official profile menu to be detected: ${JSON.stringify(status)}`);
  const injected = document.querySelector("[data-cw-menu]");
  assert.ok(injected, "expected Wallpapers beside the official Settings row");
  assert.equal(injected.textContent.trim(), "Wallpapers");
  assert.equal(injected.querySelector("[data-testid]") == null, true);
});

test("Codex Wallpapers runtime accepts the current ChatGPT shell shape", () => {
  const { window } = runWallpaperRuntime(
    "",
    '<main id="main"><form data-type="unified-composer"><div id="prompt-textarea"></div></form></main>',
  );
  assert.ok(window.__CODEX_WALLPAPERS_PUBLIC__, "expected the runtime to initialize on the current ChatGPT shell");
});

test("Codex Wallpapers validates and transfers the shared content-addressed library", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-wallpapers-transfer-"));
  try {
    fixtureLibrary(root);
    const manager = createWallpaperManager({ dataRoot: root });
    const checked = await manager.checkLibrary();
    assert.equal(checked.count, 1);
    assert.equal(checked.dataRoot, root);

    const contents = new FakeContents();
    const result = await manager.install(contents);
    assert.deepEqual(result, { status: { count: 1, enabled: true }, libraryCount: 1, transferred: 1, injected: true });
    assert.equal(contents.calls.some(call => call.includes(".append(")), true);
    assert.equal(contents.calls.some(call => call.includes(".register(")), true);
    assert.equal(contents.calls.some(call => call.includes(".ready()")), true);

    await manager.dispose(contents);
    assert.equal(contents.disposed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex Wallpapers waits through slow ChatGPT shell hydration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-wallpapers-delayed-shell-"));
  try {
    fixtureLibrary(root);
    const contents = new DelayedShellContents(5);
    const result = await createWallpaperManager({ dataRoot: root }).install(contents);
    assert.equal(result.libraryCount, 1);
    assert.equal(contents.shellChecks, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex Wallpapers launcher setup re-enables a page-side disabled preference", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-wallpapers-enable-"));
  try {
    fixtureLibrary(root);
    const contents = new FakeContents();
    contents.pageEnabled = false;
    const result = await createWallpaperManager({ dataRoot: root }).install(contents);
    assert.equal(result.status.enabled, true);
    assert.equal(contents.calls.some(call => call.includes(".setEnabled(true)")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex Wallpapers does not accept changed media after the library is indexed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-wallpapers-integrity-"));
  try {
    fixtureLibrary(root);
    const library = JSON.parse(fs.readFileSync(path.join(root, "library.json"), "utf8"));
    const item = library.items[0];
    fs.writeFileSync(path.join(root, item.file), "changed");
    const manager = createWallpaperManager({ dataRoot: root });
    await assert.rejects(() => manager.install(new FakeContents()), /media changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
