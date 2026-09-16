const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MAX_WALLPAPER_BYTES = 128 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 512 * 1024 * 1024;
const TRANSFER_CHUNK_BYTES = 384 * 1024;
const MAX_PIXEL_COUNT = 80_000_000;
const SHELL_READY_ATTEMPTS = 40;
const SHELL_READY_DELAY_MS = 250;
const FORMATS = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wallpaperDataRoot() {
  return path.resolve(
    process.env.CODEX_WALLPAPERS_DATA
      || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "CodexWallpapers"),
  );
}

function safeLibraryPath(root, relativePath) {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || path.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || relativePath.split("/").includes("..")) {
    throw new Error("Invalid Codex Wallpapers library path");
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Codex Wallpapers path leaves the library");
  }
  return resolved;
}

function validateWallpaperItem(item, ids) {
  if (!isRecord(item)) throw new Error("Invalid Codex Wallpapers media entry");
  const extension = typeof item.file === "string" ? path.extname(item.file).toLowerCase() : "";
  if (!/^[a-f0-9]{24}$/.test(item.id) || ids.has(item.id)) {
    throw new Error("Invalid or duplicate Codex Wallpapers media id");
  }
  if (!FORMATS[extension]
    || typeof item.title !== "string"
    || item.title.length > 120
    || !Number.isInteger(item.size)
    || item.size < 1
    || item.size > MAX_WALLPAPER_BYTES
    || !Number.isInteger(item.width)
    || !Number.isInteger(item.height)
    || item.width < 1
    || item.height < 1
    || item.width * item.height > MAX_PIXEL_COUNT
    || item.mime !== FORMATS[extension]
    || item.kind !== (item.mime.startsWith("video/") ? "video" : "image")
    || !/^[a-f0-9]{64}$/.test(item.sha256)
    || !item.sha256.startsWith(item.id)) {
    throw new Error("Invalid Codex Wallpapers media metadata");
  }
  ids.add(item.id);
}

async function readWallpaperLibrary(root = wallpaperDataRoot()) {
  const base = path.resolve(root);
  let data;
  try {
    const raw = await fsp.readFile(path.join(base, "library.json"), "utf8");
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return { schema: 1, items: [] };
    if (error instanceof SyntaxError) throw new Error("Codex Wallpapers library.json is not valid JSON");
    throw error;
  }
  if (!isRecord(data) || data.schema !== 1 || !Array.isArray(data.items)) {
    throw new Error("Unsupported Codex Wallpapers library format");
  }
  const ids = new Set();
  let totalBytes = 0;
  for (const item of data.items) {
    validateWallpaperItem(item, ids);
    safeLibraryPath(base, item.file);
    safeLibraryPath(base, item.preview);
    totalBytes += item.size;
    if (totalBytes > MAX_LIBRARY_BYTES) {
      throw new Error("Codex Wallpapers library exceeds the 512 MiB transfer limit");
    }
  }
  return { schema: 1, items: data.items.slice() };
}

async function readRequiredFile(filePath, description) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Codex Wallpapers ${description} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadWallpaperRuntime(assetsRoot) {
  const [runtime, appearanceCSS, modalCSS] = await Promise.all([
    readRequiredFile(path.join(assetsRoot, "runtime.js"), "runtime"),
    readRequiredFile(path.join(assetsRoot, "appearance.css"), "appearance CSS"),
    readRequiredFile(path.join(assetsRoot, "modal.css"), "modal CSS"),
  ]);
  // runtime.js is intentionally a page-side IIFE. The only value passed into it is serialized
  // CSS; it has no filesystem, process, or network access in the official Codex renderer.
  return `${runtime.trim()}\n(${JSON.stringify({ appearanceCSS, modalCSS })});`;
}

function wallpaperError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createWallpaperManager({ assetsRoot = path.resolve(__dirname, "..", "wallpapers"), dataRoot = wallpaperDataRoot() } = {}) {
  const resolvedAssetsRoot = path.resolve(assetsRoot);
  const resolvedDataRoot = path.resolve(dataRoot);
  const operations = new WeakMap();
  let runtimePromise;

  const queue = (contents, operation) => {
    const previous = operations.get(contents) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    let tracked;
    tracked = next.finally(() => {
      if (operations.get(contents) === tracked) operations.delete(contents);
    });
    operations.set(contents, tracked);
    return tracked;
  };

  const runtime = () => {
    if (!runtimePromise) runtimePromise = loadWallpaperRuntime(resolvedAssetsRoot);
    return runtimePromise;
  };

  const execute = async (contents, script) => {
    if (!contents || contents.isDestroyed?.()) throw wallpaperError("ChatGPT wallpaper surface was closed", "wallpaper_surface_closed");
    return contents.executeJavaScript(script, true);
  };

  const waitForShell = async contents => {
    for (let attempt = 0; attempt < SHELL_READY_ATTEMPTS; attempt += 1) {
      if (contents.isDestroyed?.()) throw wallpaperError("ChatGPT wallpaper surface was closed", "wallpaper_surface_closed");
      try {
        if (await execute(contents, "Boolean(document.querySelector('main[data-app-shell-main-surface]') || document.querySelector('main#main')?.querySelector('form[data-type=\"unified-composer\"], #prompt-textarea'))")) return true;
      } catch (error) {
        if (attempt === SHELL_READY_ATTEMPTS - 1) throw error;
      }
      if (attempt < SHELL_READY_ATTEMPTS - 1) await delay(SHELL_READY_DELAY_MS);
    }
    return false;
  };

  const installNow = async contents => {
    const library = await readWallpaperLibrary(resolvedDataRoot);
    if (!await waitForShell(contents)) {
      throw wallpaperError(
        "The official Codex surface is not ready for Codex Wallpapers yet",
        "wallpaper_surface_not_ready",
      );
    }

    let present = Boolean(await execute(contents, "Boolean(window.__CODEX_WALLPAPERS_PUBLIC__)"));
    let injected = false;
    if (!present) {
      await execute(contents, await runtime());
      injected = true;
      present = Boolean(await execute(contents, "Boolean(window.__CODEX_WALLPAPERS_PUBLIC__)"));
    }
    if (!present) throw wallpaperError("Codex Wallpapers did not initialize in the official Codex surface", "wallpaper_runtime_failed");

    const loadedIds = new Set(await execute(contents, "window.__CODEX_WALLPAPERS_PUBLIC__.ids()"));
    try {
      let transferred = 0;
      for (const item of library.items) {
        if (loadedIds.has(item.id)) continue;
        const mediaPath = safeLibraryPath(resolvedDataRoot, item.file);
        const previewPath = safeLibraryPath(resolvedDataRoot, item.preview);
        const bytes = await fsp.readFile(mediaPath);
        const hash = crypto.createHash("sha256").update(bytes).digest("hex");
        if (bytes.length !== item.size || hash !== item.sha256) {
          throw new Error(`Codex Wallpapers media changed: ${item.id}`);
        }
        for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES).toString("base64");
          await execute(contents, `window.__CODEX_WALLPAPERS_PUBLIC__.append(${JSON.stringify(item.id)},${JSON.stringify(chunk)})`);
        }
        const preview = (await fsp.readFile(previewPath)).toString("base64");
        const { file, preview: ignoredPreview, sha256, ...metadata } = item;
        void ignoredPreview;
        void sha256;
        await execute(contents, `window.__CODEX_WALLPAPERS_PUBLIC__.register(${JSON.stringify(metadata)},${JSON.stringify(preview)})`);
        transferred += 1;
      }
      let status = await execute(contents, "window.__CODEX_WALLPAPERS_PUBLIC__.ready()");
      // The launcher toggle is the authoritative integration switch. A user may have disabled
      // the official app's wallpaper control before a reload; turn it back on when the launcher says
      // the integration is enabled so the setting remains a real on/off toggle.
      if (status?.enabled !== true) {
        status = await execute(contents, "window.__CODEX_WALLPAPERS_PUBLIC__.setEnabled(true)");
      }
      return { status, libraryCount: library.items.length, transferred, injected };
    } catch (error) {
      // Do not remove a runtime that was already active. If this was our first injection, leave
      // the page in its original state so a later toggle can retry cleanly.
      if (injected) await execute(contents, "window.__CODEX_WALLPAPERS_PUBLIC__?.dispose()").catch(() => {});
      throw error;
    }
  };

  return {
    async checkLibrary() {
      await runtime();
      const library = await readWallpaperLibrary(resolvedDataRoot);
      return { count: library.items.length, dataRoot: resolvedDataRoot };
    },
    install(contents) {
      if (!contents || typeof contents.executeJavaScript !== "function") {
        return Promise.reject(new Error("Codex Wallpapers needs an Electron WebContents surface"));
      }
      return queue(contents, () => installNow(contents));
    },
    dispose(contents) {
      if (!contents || typeof contents.executeJavaScript !== "function") return Promise.resolve(false);
      return queue(contents, async () => {
        if (contents.isDestroyed?.()) return false;
        await execute(contents, "window.__CODEX_WALLPAPERS_PUBLIC__?.dispose()");
        return true;
      });
    },
    dataRoot: resolvedDataRoot,
    assetsRoot: resolvedAssetsRoot,
  };
}

module.exports = {
  FORMATS,
  MAX_LIBRARY_BYTES,
  MAX_PIXEL_COUNT,
  MAX_WALLPAPER_BYTES,
  SHELL_READY_ATTEMPTS,
  SHELL_READY_DELAY_MS,
  TRANSFER_CHUNK_BYTES,
  createWallpaperManager,
  loadWallpaperRuntime,
  readWallpaperLibrary,
  safeLibraryPath,
  wallpaperDataRoot,
};
