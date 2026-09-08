import { expect, test } from "bun:test";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function userImage(text: string, image: string) {
  return {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text },
      { type: "input_image", image_url: `data:image/png;base64,${image}`, detail: "high" },
    ],
  };
}

function compiledImages(input: unknown[]) {
  const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, stream: true, input });
  return compileChatGptWebPrompt(parsed, capabilities);
}

test("v2 continuation does not re-upload images that predate the latest compaction checkpoint", () => {
  const compiled = compiledImages([
    userImage("old visual evidence", "old-v2-image"),
    { type: "compaction", encrypted_content: encodeCompactionSummary("Old visual evidence was summarized.") },
    userImage("new visual evidence", "new-v2-image"),
  ]);

  expect(compiled.images.map(image => image.imageUrl)).toEqual([
    "data:image/png;base64,new-v2-image",
  ]);
  expect(compiled.text).toContain("pre-compaction image not reattached");
  expect(compiled.text).toContain("Old visual evidence was summarized.");
});

test("v1 continuation does not re-upload retained images that precede its readable summary", () => {
  const compiled = compiledImages([
    userImage("old v1 visual", "old-v1-image"),
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nThe old v1 visual was summarized.` }],
    },
    userImage("new v1 visual", "new-v1-image"),
  ]);

  expect(compiled.images.map(image => image.imageUrl)).toEqual([
    "data:image/png;base64,new-v1-image",
  ]);
  expect(compiled.text).toContain("pre-compaction image not reattached");
  expect(compiled.text).toContain("The old v1 visual was summarized.");
});

test("the first compaction still uploads current images so the checkpoint can summarize them", () => {
  const compiled = compiledImages([
    userImage("visual that has not been compacted yet", "first-epoch-image"),
    { type: "compaction_trigger" },
  ]);

  expect(compiled.images.map(image => image.imageUrl)).toEqual([
    "data:image/png;base64,first-epoch-image",
  ]);
  expect(compiled.text).not.toContain("pre-compaction image not reattached");
});

test("a repeated compaction uploads only images added since the previous checkpoint", () => {
  const compiled = compiledImages([
    userImage("already summarized image", "old-repeat-image"),
    { type: "compaction", encrypted_content: encodeCompactionSummary("The older image is already summarized.") },
    userImage("image added after checkpoint", "new-repeat-image"),
    { type: "compaction_trigger" },
  ]);

  expect(compiled.images.map(image => image.imageUrl)).toEqual([
    "data:image/png;base64,new-repeat-image",
  ]);
  expect(compiled.text).toContain("pre-compaction image not reattached");
});

test("pre-compaction tool-result images are summarized instead of being re-uploaded", () => {
  const compiled = compiledImages([
    { type: "function_call", call_id: "call_old_image", name: "view_image", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "call_old_image",
      output: [{ type: "input_image", image_url: "data:image/png;base64,old-tool-image" }],
    },
    { type: "compaction", encrypted_content: encodeCompactionSummary("The tool image was summarized.") },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ]);

  expect(compiled.images).toHaveLength(0);
  expect(compiled.text).toContain("pre-compaction image not reattached");
  expect(compiled.text).not.toContain("old-tool-image");
});

test("pre-compaction one-pixel sentinels stay non-semantic instead of becoming omission notes", () => {
  const compiled = compiledImages([
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "persisted image placeholder" },
        { type: "input_image", image_url: ONE_PIXEL_PNG },
      ],
    },
    { type: "compaction", encrypted_content: encodeCompactionSummary("No usable image was retained.") },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ]);

  expect(compiled.images).toHaveLength(0);
  expect(compiled.text).not.toContain("pre-compaction image not reattached");
  expect(compiled.text).not.toContain(ONE_PIXEL_PNG);
});
