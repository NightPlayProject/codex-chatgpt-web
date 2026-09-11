const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { resumableSavedChat } = require("../electron/saved-chats.cjs");
const key = "a".repeat(64), digest = "b".repeat(64);
const record = { url: "https://chatgpt.com/c/123", conversationKey: key, connectorIdentity: "Codex Native2", resume: { turnId: "answer-one", answerDigest: digest, domDigest: require("node:crypto").createHash("sha256").update("answer").digest("hex") } };

test("saved restart selection rejects stale history, changed models/epochs, connector changes and ambiguity", () => {
  assert.equal(resumableSavedChat([record], key, "Codex Native2", digest), record);
  for (const [rows, k, connector, hash] of [
    [[record], key, "Codex Native2", "c".repeat(64)],
    [[record], "changed-epoch", "Codex Native2", digest],
    [[record], key, "different", digest],
    [[record, record], key, "Codex Native2", digest],
    [[{ ...record, resume: null }], key, "Codex Native2", digest],
  ]) assert.equal(resumableSavedChat(rows, k, connector, hash), null);
});

test("restart restores the exact completed conversation and consumes the checkpoint before work", async () => {
  const actions = [];
  const tab = { id: "restored", surfaceId: "surface", view: { webContents: {
    loadURL: async url => actions.push(url),
    executeJavaScript: async script => { assert.match(script, /answer-one/); return "answer"; },
  } } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), userCancelledTurnOwners: new Map(),
    getSaveChats: () => true, getSavedChats: () => [record],
    createTurnTab: async () => tab,
    rememberChat: current => { assert.equal(current.savedResume, null); actions.push("consumed"); },
    writeDescriptor() {},
    syncViewVisibility() {},
  });
  const lease = await host.beginTurn("trace", false, process.pid, key, "Codex Native2", false, digest);
  assert.deepEqual(actions, [record.url, "consumed"]);
  assert.equal(lease.reused, true);
  assert.equal(lease.connectorBound, false);
});

test("failed saved-page navigation releases the new tab without sending", async () => {
  const tab = { view: { webContents: { loadURL: async () => { throw new Error("offline"); } } } };
  let removed = false;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), userCancelledTurnOwners: new Map(),
    getSaveChats: () => true, getSavedChats: () => [record], createTurnTab: async () => tab,
    removeTurnTab: value => { assert.equal(value, tab); removed = true; },
  });
  await assert.rejects(host.beginTurn("trace", false, process.pid, key, "Codex Native2", false, digest), /offline/);
  assert.equal(removed, true);
});
