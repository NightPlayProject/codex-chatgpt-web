import { expect, test } from "bun:test";
import {
  CHATGPT_STANDARD_RELIABLE_INLINE_CHAR_LIMIT,
  estimateChatGptWebInputTokens,
  estimateChatGptWebUsage,
  resolveBiggerContextMultipartParts,
  resolveStandardContextMultipartParts,
} from "../src/adapters/chatgpt-web/usage";
import {
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMaxMessageChars, compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_HIGH_RELIABLE_BROWSER_INPUT_TOKEN_LIMIT, CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
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

test("Sol reports native tool-schema pressure without inflating browser transport usage", () => {
  const parsed = request("continue retained work");
  const baselineBrowserTokens = estimateChatGptWebInputTokens(parsed, capabilities);
  const baselineUsage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities);
  parsed.context.tools = [{
    name: "large_native_tool",
    description: `Large native tool ${"description ".repeat(4_000)}`,
    parameters: {
      type: "object",
      properties: {
        payload: {
          type: "string",
          description: `Large schema ${"parameter ".repeat(4_000)}`,
        },
      },
    },
  }];

  const browserTokens = estimateChatGptWebInputTokens(parsed, capabilities);
  const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities);

  expect(browserTokens).toBe(baselineBrowserTokens);
  expect(usage.inputTokens).toBeGreaterThan(browserTokens + 1_000);
  expect(usage.inputTokens).toBeGreaterThan(baselineUsage.inputTokens);

  const luna = structuredClone(parsed);
  luna.modelId = "gpt-5.6-luna";
  luna.options.reasoning = "low";
  const lunaCapabilities = { localToolsEnabled: false, solAvailable: false, proAvailable: false };
  expect(estimateChatGptWebUsage(luna, { answer: "done" }, lunaCapabilities).inputTokens)
    .toBe(estimateChatGptWebInputTokens(luna, lunaCapabilities));
});

test("Sol provider usage includes opaque canonical reasoning history omitted from browser replay", () => {
  const parsed = request("continue after retained reasoning");
  parsed.context.messages.unshift({
    role: "assistant",
    content: [{
      type: "thinking",
      thinking: "Prior reasoning retained natively.",
      signature: "opaque-native-reasoning 0123456789 ".repeat(25_000),
    }],
    timestamp: 0,
  });

  // Browser reconstruction intentionally does not replay opaque native reasoning signatures.
  const browserTokens = estimateChatGptWebInputTokens(parsed, capabilities);
  const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities);

  expect(browserTokens).toBeLessThan(20_000);
  expect(usage.inputTokens).toBeGreaterThan(browserTokens + 100_000);
  expect(usage.inputTokens).toBeGreaterThan(120_000);
});

test("Sol provider usage counts raw native encrypted reasoning that parser intentionally cannot replay", () => {
  const opaqueReasoning = `native-opaque-reasoning:${"A7f3K9mQ2xP5vN8zR4tY6uW1 ".repeat(18_000)}`;
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    stream: false,
    reasoning: { effort: "high" },
    input: [
      { type: "reasoning", id: "rs_native", summary: [], encrypted_content: opaqueReasoning },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue the retained task" }] },
    ],
  });

  // Non-bridge encrypted reasoning is intentionally absent from parsed semantic messages, but it
  // remains part of the native Responses history and must contribute to auto-compaction pressure.
  expect(JSON.stringify(parsed.context.messages)).not.toContain("native-opaque-reasoning");
  const browserTokens = estimateChatGptWebInputTokens(parsed, capabilities);
  const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities);
  expect(browserTokens).toBeLessThan(20_000);
  expect(usage.inputTokens).toBeGreaterThan(browserTokens + 50_000);
  // Regression for the Standard Context hard-window failure: the browser-visible/canonical prompt
  // can look small while opaque native Responses history alone has already crossed the 400k
  // auto-compaction threshold. Keep this fixture below the 500k hard window so Codex has real
  // headroom to request /responses/compact instead of failing at the ceiling.
  expect(usage.inputTokens).toBeGreaterThanOrEqual(400_000);
  expect(usage.inputTokens).toBeLessThan(500_000);
});

test("completed local context compaction rebases Sol native usage exactly once", () => {
  const opaqueReasoning = `native-opaque-reasoning:${"A7f3K9mQ2xP5vN8zR4tY6uW1 ".repeat(18_000)}`;
  const before = parseRequest({
    model: "gpt-5.6-sol",
    stream: false,
    reasoning: { effort: "high" },
    input: [
      { type: "reasoning", id: "rs_native", summary: [], encrypted_content: opaqueReasoning },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue the retained task" }] },
    ],
  });
  expect(estimateChatGptWebUsage(before, { answer: "done" }, capabilities).inputTokens)
    .toBeGreaterThanOrEqual(400_000);

  const summary = `${SUMMARY_PREFIX}\nCompleted the prior work and preserve its constraints.`;
  const compactedInput = [
    { type: "reasoning", id: "rs_native", summary: [], encrypted_content: opaqueReasoning },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue the retained task" }] },
    { type: "context_compaction" },
    { type: "message", role: "user", content: [{ type: "input_text", text: summary }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue after automatic compaction" }] },
  ];
  const after = parseRequest({
    model: "gpt-5.6-sol",
    stream: false,
    reasoning: { effort: "high" },
    input: compactedInput,
  });
  const afterUsage = estimateChatGptWebUsage(after, { answer: "done" }, capabilities).inputTokens;
  expect(afterUsage).toBeLessThan(100_000);

  const severalTurnsLater = parseRequest({
    model: "gpt-5.6-sol",
    stream: false,
    reasoning: { effort: "high" },
    input: [
      ...compactedInput,
      ...Array.from({ length: 8 }, (_, index) => ({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `small post-compaction turn ${index}` }],
      })),
    ],
  });
  expect(estimateChatGptWebUsage(severalTurnsLater, { answer: "done" }, capabilities).inputTokens)
    .toBeLessThan(100_000);
});

test("payloadless context compaction marker does not lower Sol usage until its readable summary exists", () => {
  const opaqueReasoning = `native-opaque-reasoning:${"A7f3K9mQ2xP5vN8zR4tY6uW1 ".repeat(18_000)}`;
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    stream: false,
    reasoning: { effort: "high" },
    input: [
      { type: "reasoning", id: "rs_native", summary: [], encrypted_content: opaqueReasoning },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue retained work" }] },
      { type: "context_compaction" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "ordinary user text, not a compaction summary" }] },
    ],
  });

  expect(estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities).inputTokens)
    .toBeGreaterThanOrEqual(400_000);
});

test("Sol raw native usage omits inline image bytes while retaining surrounding history", () => {
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    stream: false,
    reasoning: { effort: "high" },
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "inspect this retained image" },
        { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(1_000_000)}`, detail: "high" },
      ],
    }],
  });

  const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities);
  expect(usage.inputTokens).toBeLessThan(50_000);
});

test("Sol canonical usage does not turn base64 image bytes into text-context pressure", () => {
  const parsed = request("inspect the retained image");
  parsed.context.messages.push({
    role: "user",
    content: [{
      type: "image",
      imageUrl: `data:image/png;base64,${"A".repeat(1_000_000)}`,
      detail: "original",
    }],
    timestamp: 2,
  });

  const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities);
  expect(usage.inputTokens).toBeLessThan(50_000);
});

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

test("v2 compaction replacement does not replay the large source history into the next Plus High browser turn", () => {
  const plus = { ...capabilities, proAvailable: false };
  const fill = (prefix: string, chars: number): string => (
    `${prefix} ${"synthetic-context-fixture alpha beta gamma delta epsilon zeta eta theta 0123456789 ".repeat(Math.ceil(chars / 80))}`
      .slice(0, chars)
  );
  const oldA = fill("PRE_COMPACTION_SENTINEL_A", 117_715);
  const oldB = fill("PRE_COMPACTION_SENTINEL_B", 138_305);
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    stream: false,
    reasoning: { effort: "high" },
    instructions: fill("CURRENT_DEVELOPER_CONTEXT", 43_850),
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: oldA }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: oldB }] },
      { type: "compaction", encrypted_content: encodeCompactionSummary(fill("CHECKPOINT", 19_200)) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue after compaction" }] },
    ],
  });

  const compiled = compileChatGptWebPrompt(parsed, plus);
  expect(compiled.text).not.toContain("PRE_COMPACTION_SENTINEL_A");
  expect(compiled.text).not.toContain("PRE_COMPACTION_SENTINEL_B");
  expect(compiled.text).toContain("CHECKPOINT");
  expect(estimateChatGptWebInputTokens(parsed, plus))
    .toBeLessThan(CHATGPT_WEB_HIGH_RELIABLE_BROWSER_INPUT_TOKEN_LIMIT);
  expect(estimateChatGptWebUsage(parsed, { answer: "done" }, plus).inputTokens)
    .toBeLessThan(CHATGPT_WEB_HIGH_RELIABLE_BROWSER_INPUT_TOKEN_LIMIT);
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

test("near-threshold Sol compaction expands beyond three parts while preserving every semantic record", () => {
  const caps = {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: true,
    experimentalBiggerContext: true,
  };
  const fill = (chars: number): string => (
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega 0123456789 "
      .repeat(Math.ceil(chars / 130))
      .slice(0, chars)
  );
  const contents = Array.from({ length: 16 }, (_, index) => "record-" + index + " " + fill(97_000));
  const parsed: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: false,
    _compactionRequest: true,
    context: {
      messages: contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 })),
    },
    options: { reasoning: "high" },
  };

  const parts = resolveBiggerContextMultipartParts(parsed, caps);
  expect(parts).toBeGreaterThan(3);
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
  expect(compiled.multipart?.parts).toHaveLength(parts!);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();

  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  expect(records).toEqual(contents.map((content, message_index) => ({
    kind: "message",
    message_index,
    message: { role: "user", content },
  })));

  const transactionId = "ctx_0123456789abcdef0123456789abcdef";
  const stages = compiled.multipart!.parts.slice(0, -1).map((payload, index) => (
    formatChatGptWebMultipartStage(payload, transactionId, index + 1, parts!).text
  ));
  const final = formatChatGptWebMultipartCommit(compiled.multipart!, transactionId);
  const messages = [...stages, final];
  const tokens = messages.map(text => estimateTokens(text, parsed.modelId));
  const chars = messages.map(text => text.length);
  const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
  const maxStageChars = Math.max(...chars.slice(0, -1));
  const staging = resolveChatGptWebMultipartStagingMode(
    parsed.modelId,
    caps,
    maxStageMessageTokens,
    maxStageChars,
  );

  expect(final).toContain("parts: " + parts);
  expect(final).toContain("acknowledged_parts: " + (parts! - 1) + "/" + parts);
  for (let index = 0; index < parts!; index += 1) {
    expect(final).toMatch(new RegExp((index + 1) + "/" + parts + ":[a-f0-9]{64}"));
  }
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
    Math.max(...tokens),
    parsed.modelId,
    "high",
    caps,
    Math.max(...chars),
    parts!,
    {
      stagingEffort: staging.effort,
      maxStageMessageTokens,
      maxStageChars,
      finalMessageTokens: tokens.at(-1)!,
      finalMessageChars: chars.at(-1)!,
      finalImageTokens: estimateChatGptWebImageTokens(compiled),
    },
    true,
  )).not.toThrow();
}, 30_000);

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
