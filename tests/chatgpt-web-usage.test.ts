import { expect, test } from "bun:test";
import {
  CHATGPT_STANDARD_RELIABLE_INLINE_CHAR_LIMIT,
  estimateChatGptWebInputTokens,
  resolveBiggerContextMultipartParts,
  resolveStandardContextMultipartParts,
} from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMaxMessageChars, compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), 3],
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), 2],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual([...contents]);
    }
  }
}, 60_000);

test("Standard Context proactively stages only the empirically unstable large inline band", () => {
  const plus = { ...capabilities, proAvailable: false };
  const small = request("ordinary context");
  expect(resolveStandardContextMultipartParts(small, plus)).toBeUndefined();

  const compileEnvelope = (targetChars: number): CodexParsedRequest => {
    const empty = request("");
    const fixedChars = compiledChatGptWebMaxMessageChars(compileChatGptWebPrompt(empty, plus));
    const parsed = request("x".repeat(targetChars - fixedChars));
    expect(compiledChatGptWebMaxMessageChars(compileChatGptWebPrompt(parsed, plus))).toBe(targetChars);
    return parsed;
  };

  expect(
    resolveStandardContextMultipartParts(
      compileEnvelope(CHATGPT_STANDARD_RELIABLE_INLINE_CHAR_LIMIT - 1),
      plus,
    ),
  ).toBeUndefined();
  expect(
    resolveStandardContextMultipartParts(
      compileEnvelope(CHATGPT_STANDARD_RELIABLE_INLINE_CHAR_LIMIT),
      plus,
    ),
  ).toBe(2);

  // Live 7005 trace 4757df296eba failed four consecutive High submissions at this exact browser
  // envelope while a fresh small High turn succeeded through the same running bridge.
  const reproducedFailure = compileEnvelope(159_147);
  expect(resolveStandardContextMultipartParts(reproducedFailure, plus)).toBe(2);

  // Keep the workaround narrow: ordinary/smaller Standard Context requests remain one message.
  const belowObservedBand = compileEnvelope(140_000);
  expect(resolveStandardContextMultipartParts(belowObservedBand, plus)).toBeUndefined();

  const large = request("x".repeat(CHATGPT_STANDARD_RELIABLE_INLINE_CHAR_LIMIT + 20_000));
  expect(resolveStandardContextMultipartParts(large, plus)).toBe(2);

  const luna = structuredClone(large);
  luna.modelId = "gpt-5.6-luna";
  expect(resolveStandardContextMultipartParts(luna, plus)).toBeUndefined();

  const zeroRisk = structuredClone(large);
  zeroRisk.modelId = CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL;
  expect(resolveStandardContextMultipartParts(zeroRisk, plus)).toBeUndefined();

  const compaction = structuredClone(large);
  compaction._compactionRequest = true;
  expect(resolveStandardContextMultipartParts(compaction, plus)).toBeUndefined();
});

test("Bigger Context compaction selects three parts before the legacy inline byte budget", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(3);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { proAvailable: false, images: 3, schema: false },
    { proAvailable: true, images: 10, schema: false },
    { proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(24_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 3 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), 3,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens[2]!, finalMessageChars: chars[2]!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
      true,
    )).not.toThrow();
  }
}, 30_000);
