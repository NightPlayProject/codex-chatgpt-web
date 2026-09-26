import { expect, test } from "bun:test";
import {
  buildCompactV1Output,
  extractCompactUserMessages,
  isReadableCompactionSummaryText,
  SUMMARY_PREFIX,
} from "../src/responses/compaction";

test("recognizes both Codex v1 and transparent v2 readable compaction summaries", () => {
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\nv1 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\n\nv2 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}not a summary boundary`)).toBe(false);
});

test("v1 compaction keeps only the newest ten structured images without copying them into text", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    type: "message",
    role: "user",
    id: `user-${index}`,
    metadata: { source: `turn-${index}` },
    content: [
      { type: "input_text", text: `request-${index}` },
      {
        type: "input_image",
        image_url: `data:image/png;base64,image-${index}`,
        detail: "high",
      },
    ],
  }));

  const output = buildCompactV1Output(extractCompactUserMessages(input), "checkpoint");
  const retained = output.slice(0, -1) as Array<{
    id?: string;
    metadata?: { source?: string };
    content: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
  }>;
  expect(retained).toHaveLength(12);
  expect(retained.map(item => item.id)).toEqual(input.map(item => item.id));
  expect(retained.map(item => item.metadata?.source)).toEqual(input.map(item => item.metadata.source));
  const imageUrls = retained.flatMap(item => item.content
    .filter(block => block.type === "input_image")
    .map(block => block.image_url));
  expect(imageUrls).toEqual(input.slice(2).map(item => item.content[1]!.image_url));
  expect(retained.flatMap(item => item.content)
    .filter(block => block.type === "input_text")
    .every(block => !block.text?.includes("data:image"))).toBe(true);
  expect(retained.at(-1)?.content.at(-1)).toMatchObject({ detail: "high" });
});

test("v1 compaction drops native user-role context kinds without dropping user.text markup", () => {
  const nativeContext = {
    type: "message", role: "user", id: "native-context",
    content: [{ type: "input_text", text: "<recommended_plugins>Example plugin</recommended_plugins>" }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn-current", content_item_kinds: ["plugins.recommendations", "environments.environment_context"],
    },
  };
  const humanMarkup = {
    type: "message", role: "user", id: "human-markup",
    content: [{ type: "input_text", text: "<recommended_plugins>This is literal user text</recommended_plugins>" }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "turn-human", content_item_kinds: ["user.text"],
    },
  };
  const output = buildCompactV1Output(extractCompactUserMessages([humanMarkup, nativeContext]), "checkpoint");
  expect(output.some(item => item.id === nativeContext.id)).toBe(false);
  expect(output.some(item => item.id === humanMarkup.id)).toBe(true);
});

test("v1 compaction drops persisted one-pixel image sentinels", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const output = buildCompactV1Output(extractCompactUserMessages([{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "keep the request" },
      { type: "input_image", image_url: placeholder },
      { type: "input_image", image_url: "data:image/png;base64,real-image" },
    ],
  }]), "checkpoint");

  expect(JSON.stringify(output)).not.toContain(placeholder);
  expect(JSON.stringify(output)).toContain("data:image/png;base64,real-image");
});

test("v1 compaction can narrow retained raw text without clipping the checkpoint summary", () => {
  const text = Array.from({ length: 30_000 }, (_, index) => String(index % 10)).join("");
  const output = buildCompactV1Output(extractCompactUserMessages([{
    type: "message",
    role: "user",
    id: "large-user",
    content: [{ type: "input_text", text }],
  }]), "checkpoint survives intact", { retainedTextTokenBudget: 2_000 });

  const retained = output[0] as { content: Array<{ type: string; text?: string }> };
  expect(retained.content).toEqual([{
    type: "input_text",
    text: text.slice(-8_000),
  }]);
  expect(JSON.stringify(output.at(-1))).toContain("checkpoint survives intact");
});
