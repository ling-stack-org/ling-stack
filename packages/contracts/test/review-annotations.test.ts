import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewAnnotation, renderReviewAnnotation } from "../dist/index.js";
import { isConversationItemV1 } from "../dist/index.js";
import { projectConversationItemToChannelMessage } from "../dist/index.js";

test("review anchors preserve ranges, sides, revision and image coordinates", () => {
  const code = { kind: "code", id: "c1", text: "Handle the missing file", side: "left", startLine: 4, revision: "run:1", diffHunk: "@@ -4 +4 @@\n-old\n+next" } as const;
  assert.deepEqual(parseReviewAnnotation(code), code);
  assert.match(renderReviewAnnotation(code, 8), /Original lines 4-8.*revision run:1/s);
  const image = { kind: "image", id: "i1", text: "Move this icon", source: "artifact", sourceId: "art1", x: 0.42, y: 0.61 } as const;
  assert.deepEqual(parseReviewAnnotation(image), image);
  assert.match(renderReviewAnnotation(image), /x: 42%, y: 61%/);
  const workspaceImage = { ...image, id: "i2", source: "workspace_file", sourceId: "assets/icon.png" } as const;
  assert.deepEqual(parseReviewAnnotation(workspaceImage), workspaceImage);
  for (const x of [NaN, Infinity, -0.1, 1.1, "0.5"]) assert.throws(() => parseReviewAnnotation({ ...image, x }));
  for (const invalid of [{ ...code, text: "" }, { ...code, text: "a".repeat(8001) }, { ...code, startLine: 1.5 }, { ...code, side: "both" }]) assert.throws(() => parseReviewAnnotation(invalid));
  assert.equal(parseReviewAnnotation(undefined), undefined);
});

test("canonical user messages keep independent comments on the same location", () => {
  const annotation = { kind: "code", id: "one", text: "First", side: "right", startLine: 3 } as const;
  const item = { schemaVersion: 1, visibility: "thread_participants", id: "item", workspaceId: "workspace", channelId: "channel", threadId: "thread", sequence: 1, kind: "user_message", actorType: "local_user", status: "committed", revision: 1,
    payload: { body: "Review", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [
      { path: "src/a.ts", line: 4, source: "composer", annotation }, { path: "src/a.ts", line: 4, source: "composer", annotation: { ...annotation, id: "two", text: "Second" } }] },
    committedAt: "2026-11-17T00:00:00.000Z", domainRefs: [], createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z" };
  assert.ok(isConversationItemV1(item));
  if (!isConversationItemV1(item)) return;
  assert.equal(projectConversationItemToChannelMessage(item).fileRefs[0]?.annotation?.text, "First");
});
