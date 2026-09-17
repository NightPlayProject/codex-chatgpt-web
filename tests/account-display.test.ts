import { expect, test } from "bun:test";
import { formatAccountDisplayName, formatAccountEmail } from "../launcher/src/account-display";

test("email privacy also masks account names that came from the email field", () => {
  const account = { name: "kingcurry650@gmail.com", email: "kingcurry650@gmail.com" };
  expect(formatAccountDisplayName(account, false)).toBe("k•••••@gmail.com");
  expect(formatAccountDisplayName(account, true)).toBe("kingcurry650@gmail.com");
});

test("email privacy masks an email embedded in a custom account label", () => {
  const account = { name: "Primary (kingcurry650@gmail.com)", email: "kingcurry650@gmail.com" };
  expect(formatAccountDisplayName(account, false)).toBe("Primary (k•••••@gmail.com)");
});

test("email formatting retains the existing masked and visible forms", () => {
  expect(formatAccountEmail("user@example.com", false)).toBe("u•••@example.com");
  expect(formatAccountEmail("user@example.com", true)).toBe("user@example.com");
});
