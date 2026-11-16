import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelMessageFileRef } from "@ling-stack/contracts";
import { acknowledgeReviewDraft, readReviewDraft, reviewAnnotationVersion, reviewDraftKey, upsertReviewDraft } from "../src/shared/conversation/review/review-draft.ts";
import { appendImageDrawing, EMPTY_IMAGE_DRAFT, imageCanvasSize, imagePoint, parseImageEditDraft, validateImageSize, type ImageDrawing } from "../src/shared/conversation/review/image-drawing.ts";
import { codeReviewDraftKey, readCodeReviewDraft, reviewDiffContext } from "../src/shared/conversation/review/code-review-draft.ts";

const ref: ChannelMessageFileRef = { path: "src/a.ts", source: "composer", line: 8, annotation: { kind: "code", id: "c1", text: "Check this", side: "left", startLine: 4 } };
test("drafts isolate owners, reject corrupt ranges and recover after reload", () => {
  const entries = new Map<string, string>(); const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  storage.setItem(reviewDraftKey("one"), JSON.stringify([ref]));
  assert.deepEqual(readReviewDraft(storage, "one"), [ref]); assert.deepEqual(readReviewDraft(storage, "two"), []);
  storage.setItem(reviewDraftKey("one"), JSON.stringify([{ ...ref, line: 2 }])); assert.deepEqual(readReviewDraft(storage, "one"), []);
  storage.setItem(reviewDraftKey("one"), "broken"); assert.deepEqual(readReviewDraft(storage, "one"), []);
  const blank = { ...ref, annotation: { ...ref.annotation!, text: "" } };
  storage.setItem(reviewDraftKey("one"), JSON.stringify([blank])); assert.deepEqual(readReviewDraft(storage, "one"), [blank]);
  assert.deepEqual(readReviewDraft({ getItem: () => { throw new Error("disabled"); }, setItem() {} }, "one"), []);
});
test("unfinished code drafts bind to owner, path, revision and the viewed diff", () => {
  const key = codeReviewDraftKey("one", "a.ts", "revision", "diff");
  for (const other of [codeReviewDraftKey("two", "a.ts", "revision", "diff"), codeReviewDraftKey("one", "b.ts", "revision", "diff"), codeReviewDraftKey("one", "a.ts", "next", "diff"), codeReviewDraftKey("one", "a.ts", "revision", "changed")]) assert.notEqual(key, other);
  const selection = { side: "right" as const, line: 99, startLine: 99, sourceStart: 5, sourceEnd: 5 };
  assert.deepEqual(readCodeReviewDraft(key, { getItem: () => JSON.stringify({ selection, text: "Unfinished" }) }), { selection, text: "Unfinished" });
  assert.equal(readCodeReviewDraft(key, { getItem: () => JSON.stringify({ selection: { ...selection, line: 3 }, text: "Wrong range" }) }), undefined);
  const diff = ["@@ -1 +1 @@", "-unrelated", "+unrelated", "@@ -99 +99 @@", "+selected"].join("\n");
  assert.equal(reviewDiffContext(diff, selection), "@@ -99 +99 @@\n+selected");
  const huge = ["@@ -1,3 +1,4 @@", `+${"a".repeat(25_000)}`, "@@ -99 +99 @@", "+selected"].join("\n");
  assert.equal(reviewDiffContext(huge, { ...selection, sourceStart: 4, sourceEnd: 4 }), "@@ -99 +99 @@\n+selected");
});
test("image draft recovers history, dimensions and unfinished comments and rejects corrupt canvases", () => {
  const draft = { ...EMPTY_IMAGE_DRAFT, history: [{ tool: "brush", color: "#ff0000", width: .01, points: [{ x: .2, y: .3 }] }], cursor: 1,
    mode: "comment", size: { width: 320, height: 240 }, width: "320", height: "240", point: { x: .4, y: .5 }, comment: "Keep this", artifactId: "artifact_edited" };
  assert.deepEqual(parseImageEditDraft(draft), draft);
  for (const value of [{ ...draft, cursor: 2 }, { ...draft, size: { width: 8192, height: 8192 } }, { ...draft, artifactId: "../private" }, { ...draft, point: { x: Infinity, y: 0 } }, { ...draft, history: [{ ...draft.history[0], points: [] }] }]) assert.deepEqual(parseImageEditDraft(value), EMPTY_IMAGE_DRAFT);
});
test("send acknowledgement retires accepted versions and keeps in-flight edits", () => {
  const edited = { ...ref, annotation: { ...ref.annotation!, text: "Revised comment" } };
  assert.deepEqual(upsertReviewDraft([ref], edited), [edited]);
  assert.deepEqual(acknowledgeReviewDraft([edited], [ref]), [edited]);
  assert.deepEqual(acknowledgeReviewDraft([ref], [ref]), []);
  assert.deepEqual(acknowledgeReviewDraft([{ annotation: ref.annotation, source: ref.source, line: ref.line, path: ref.path }], [ref]), []);
  assert.throws(() => upsertReviewDraft(Array.from({ length: 12 }, (_, index) => ({ ...ref, annotation: { ...ref.annotation!, id: String(index) } })), ref), /12/);
});
test("recovered feedback ignores field order and retires only accepted comments", () => {
  const canonical = { ...ref, annotation: { text: "Check this", startLine: 4, side: "left", id: "c1", kind: "code" } } satisfies ChannelMessageFileRef;
  assert.equal(reviewAnnotationVersion(ref.annotation), reviewAnnotationVersion(canonical.annotation));
  const changed = { ...ref, annotation: { ...ref.annotation!, text: "Edited during recovery" } };
  assert.notEqual(reviewAnnotationVersion(ref.annotation), reviewAnnotationVersion(changed.annotation));
  const added = { ...ref, annotation: { ...ref.annotation!, id: "c2", text: "Additional feedback" } };
  assert.deepEqual(acknowledgeReviewDraft([ref, added], [canonical]), [added]);
  assert.deepEqual(acknowledgeReviewDraft([changed, added], [canonical]), [changed, added]);
});
test("coordinates use the image rectangle and drawing history drops redo after a new stroke", () => {
  assert.deepEqual(imagePoint(150, 100, { left: 100, top: 50, width: 200, height: 100 }), { x: .25, y: .5 });
  assert.deepEqual(imagePoint(0, 1000, { left: 100, top: 50, width: 200, height: 100 }), { x: 0, y: 1 });
  const brush: ImageDrawing = { tool: "brush", color: "#ff0000", width: .01, points: [{ x: .2, y: .3 }] };
  const eraser: ImageDrawing = { ...brush, tool: "eraser" };
  assert.deepEqual(appendImageDrawing([brush, eraser], 1, brush), [brush, brush]);
  const full = Array.from({ length: 200 }, () => brush);
  assert.throws(() => appendImageDrawing(full, full.length, eraser), /200/);
  assert.equal(full.length, 200);
  assert.equal(appendImageDrawing(full, 199, eraser).at(-1), eraser);
  validateImageSize(4096, 4096);
  for (const [width, height] of [[0, 1], [1, 1.5], [8193, 1], [8192, 8192], [NaN, 5]]) assert.throws(() => validateImageSize(width!, height!));
});
test("large originals use a bounded canvas without upscaling smaller images", () => {
  assert.deepEqual(imageCanvasSize(640, 480), { width: 640, height: 480 });
  assert.deepEqual(imageCanvasSize(9000, 10), { width: 8192, height: 9 });
  for (const [width, height] of [[6000, 4000], [12000, 9000], [20000, 50]]) {
    const size = imageCanvasSize(width!, height!);
    validateImageSize(size.width, size.height);
    assert.ok(size.width <= width! && size.height <= height!);
    assert.ok(Math.abs(size.height / size.width - height! / width!) < 0.01);
  }
});
