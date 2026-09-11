const test = require("node:test");
const assert = require("node:assert/strict");
const { savedChatUrl, rememberSavedChat } = require("../electron/saved-chats.cjs");

test("saved chat history accepts only concrete ChatGPT conversation URLs", () => {
  for (const url of ["https://chatgpt.com/", "https://evil.test/c/123", "https://chatgpt.com/c/123?temporary-chat=true", "https://user:pass@chatgpt.com/c/123", "https://chatgpt.com/c/123/other"]) {
    assert.equal(savedChatUrl(url), null);
  }
  assert.equal(savedChatUrl("https://chatgpt.com/c/123-abc?tracking=ignored#fragment"), "https://chatgpt.com/c/123-abc");
});

test("temporary chats are excluded; saved chats are deduplicated and retain task identity", () => {
  const empty = [];
  const tab = { url: "https://chatgpt.com/c/123", pageTitle: "Task", conversationKey: "task-one" };
  assert.equal(rememberSavedChat(empty, tab), empty);
  const records = rememberSavedChat(empty, { ...tab, saveChat: true }, "2026-09-11T00:00:00Z");
  assert.equal(records.length, 1);
  assert.equal(records[0].conversationKey, "task-one");
  assert.equal(rememberSavedChat(records, { ...tab, saveChat: true }), records);
  const updated = rememberSavedChat(records, { ...tab, saveChat: true, pageTitle: "Renamed" });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].title, "Renamed");
});

test("saved conversation index stays bounded", () => {
  let rows = [];
  for (let i = 0; i < 110; i++) rows = rememberSavedChat(rows, { saveChat: true, url: `https://chatgpt.com/c/${i}` });
  assert.equal(rows.length, 100);
  assert.equal(rows[0].url, "https://chatgpt.com/c/109");
});
