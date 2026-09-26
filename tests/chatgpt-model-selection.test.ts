import { expect, test } from "bun:test";
import { assertChatGptModelFamily, chatGptModelFamilyMatches, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

test("model selection recognizes Latest in the launcher languages without accepting other model names", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["最新", true], ["최신", true], ["GPT-6 Pro", true],
    ["GPT-5.6 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[1];
    const selection = selectChatGptModelFamily({} as Parameters<typeof selectChatGptModelFamily>[0], menu, "6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});

test("family confirmation separates Latest staging from the actual Pro response", () => {
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["High, 3 of 3.", "Use Left and Right arrow keys to adjust power"], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["Medium, 2 of 3."], "5.6", "medium")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBe(true);
  for (const descriptions of [[], ["Try Pro for more reasoning"], ["5.6 High, 3 of 5."], ["5.6 Pro, 5 of 5."],
    ["7 Pro, 5 of 5."], ["6 Sol Pro, 5 of 5."], ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], ["6 Pro for better answers"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "max")).toBe(false);
  }
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "xhigh")).toBe(false);
  expect(chatGptModelFamilyMatches(["High, 3 of 3."], "5.6", "medium")).toBe(false);
  expect(chatGptModelFamilyMatches(["5.6 Medium, 2 of 5."], "5.6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["GPT-5.5 High, 3 of 3."], "5.6", "high")).toBe(false);
});

test("effort-only announcements still require the requested model row to be checked", async () => {
  const menu = (checked: boolean) => ({
    menu: { getByRole: (_role: string, options: { name: RegExp }) => ({
      count: async () => Number(options.name.test("GPT-5.6 Sol")),
      getAttribute: async () => String(checked),
    }) },
    slider: {
      getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": "2", "aria-valuenow": "2" })[name as "aria-valuemin"],
      locator: () => ({ evaluate: async () => ["High, 3 of 3.", "Use Left and Right arrow keys to adjust power"] }),
    },
  }) as unknown as Parameters<typeof assertChatGptModelFamily>[0];
  await expect(assertChatGptModelFamily(menu(true), "5.6", "high", 2)).resolves.toBeUndefined();
  await expect(assertChatGptModelFamily(menu(false), "5.6", "high", 2)).rejects.toThrow("could not be selected and verified");
});
