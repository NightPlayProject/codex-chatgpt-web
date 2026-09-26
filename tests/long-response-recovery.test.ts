import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";

test("accepted long reasoning waits for its assistant without resubmitting", async () => {
  let clock = 0;
  const realNow = Date.now;
  const hidden = { filter() { return this; }, last() { return this; }, isVisible: async () => false };
  const page = { isClosed: () => false, locator: () => hidden };
  let observations = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    submissionDomState: async () => ({
      turnIdentities: ["user", ...(observations++ >= 3 ? ["answer"] : [])],
      userIdentities: ["user"], responseIdentities: observations > 3 ? ["answer"] : [],
      visibleStopButtonCount: 1,
    }),
    waitForTurnDomOrExternalProgress: async () => { clock += 50_000; },
  });
  try {
    Date.now = () => clock;
    const result = await worker.waitForNewAssistantTurn(page, { initialTurnIdentities: [], domCache: {} }, undefined);
    expect(result.identity).toBe("answer");
    expect(clock).toBe(150_000);
  } finally { Date.now = realNow; }
});

test("a running response may temporarily unmount; idle grace starts when generation stops", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000);
  const state = { responsePresent: true, running: true, currentText: "", completionActionVisible: false };
  tracker.update(state, 0);
  expect(tracker.update({ ...state, responsePresent: false }, 120_000)).toBeUndefined();
  expect(tracker.update({ ...state, responsePresent: false, running: false }, 121_000)).toBeUndefined();
  expect(tracker.update({ ...state, responsePresent: false, running: false }, 122_000)).toContain("disappeared");
});
