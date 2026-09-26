const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createUpdateController } = require("../electron/update.cjs");

for (const failure of ["interrupted", "checksum", "worker"]) {
  test(`update recovers from ${failure} failure without running an installer`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-recovery-"));
    const asset = "codex-web-gpt-1.2.0-win-x64.exe";
    const body = "synthetic installer bytes";
    const hash = createHash("sha256").update(body).digest("hex");
    let attempt = 0, lastPath, workers = 0;
    const controller = createUpdateController({
      currentVersion: "1.1.0", platform: "win32", arch: "x64", packaged: true,
      executablePath: path.join(root, "app.exe"), runtimeExecutable: process.execPath, logsDirectory: root,
      dependencies: {
        fetchRelease: async () => ({ tag_name: "v1.2.0", assets: [asset, "checksums.txt"].map(name => ({ name, browser_download_url: `https://github.com/NightPlayProject/codex-chatgpt-web/releases/download/v1.2.0/${name}` })) }),
        downloadText: async () => `${hash}  ${asset}\n`,
        downloadFile: async (_url, target) => {
          lastPath = target; attempt++;
          fs.writeFileSync(target, attempt === 1 && failure !== "worker" ? "partial" : body);
          if (attempt === 1 && failure === "interrupted") throw new Error("connection lost");
        },
        spawnWorker: () => {
          if (attempt === 1 && failure === "worker") throw new Error("worker unavailable");
          workers++; return { pid: 123, unref() {}, kill() {} };
        },
      },
    });
    let launch;
    try {
      await controller.checkOnce();
      await assert.rejects(controller.beginInstall());
      assert.equal(controller.getState().status, "available");
      assert.equal(fs.existsSync(lastPath), false);
      assert.equal(workers, 0);
      launch = await controller.beginInstall();
      assert.equal(workers, 1);
      assert.equal(controller.getState().status, "installing");
      controller.cancelInstall(launch);
      assert.equal(controller.getState().status, "available");
    } finally {
      if (launch) controller.cancelInstall(launch);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
