const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

const producer = `
process.stdout.write('-----BEGIN PRIVATE');
setTimeout(() => {
  process.stdout.write(' KEY-----\\r\\n');
  process.stdout.write('sensitive-body'.repeat(6000));
  setTimeout(() => {
    process.stdout.write('sensitive-tail\\n-----END PRIVATE KEY-----\\n');
    process.stderr.write('ordinary stderr\\n');
    process.stdout.write('{"result":"ordinary success"}\\n');
  }, 20);
}, 20);
`;

for (const kind of ["operation", "daemon"]) {
  test(`${kind} child output suppresses chunked private keys but preserves ordinary output`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stream-redaction-"));
    const rows = [];
    const logger = Object.fromEntries(["info", "warn", "error"].map(level => [level, (event, detail) => rows.push({ event, detail })]));
    const options = { app: { getVersion: () => "0.2.0", getPath: () => root, isPackaged: false }, logger, sourceRoot: root, coreHome: root, browserDescriptorPath: path.join(root, "browser.json") };
    const invocation = { executable: process.execPath, args: ["-e", producer], cwd: root };
    try {
      if (kind === "operation") {
        const host = new RuntimeHost(options);
        host.command = () => invocation;
        const result = await host.run("fixture", [], { timeoutMs: 5000 });
        assert.match(result.stdout, /sensitive-body/); // Raw command results are not diagnostic logs.
        assert.match(result.stdout, /ordinary success/);
      } else {
        const supervisor = new RuntimeSupervisor(options);
        const child = supervisor.spawnChild("daemon", invocation);
        await once(child, "close");
      }
      const serialized = JSON.stringify(rows);
      assert.doesNotMatch(serialized, /sensitive-body|sensitive-tail/);
      assert.match(serialized, /ordinary success/);
      assert.match(serialized, /ordinary stderr/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
