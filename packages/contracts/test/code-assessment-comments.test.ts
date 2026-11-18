import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCodeAssessmentLineAnchor, codeAssessmentSnapshotAnchors, parseCodeAssessmentInstructions,
  parseCreateCodeAssessmentComment, type CodeAssessmentSnapshot } from "../dist/index.js";

const snapshot: CodeAssessmentSnapshot = { id: "snapshot", digest: "a".repeat(64), capturedAt: "2026-11-17T00:00:00Z", target: { type: "working_tree" },
  files: [{ path: "src/a.ts", kind: "modified", diff: "@@ -1,2 +1,2 @@\n context\n-old\n+new\n@@ -3 +3 @@\n-other\n+changed\n", contentDigest: "b".repeat(64), redacted: false }],
  totalFileCount: 1, coverage: "complete", exclusions: [] };
const input = { snapshotDigest: snapshot.digest, path: "src/a.ts", side: "new" as const, startLine: 2, endLine: 2, body: "  Reviewed this edge case.  " };

test("guidance is optional, trimmed and bounded without accepting authority objects", () => {
  assert.equal(parseCodeAssessmentInstructions(undefined), undefined);
  assert.equal(parseCodeAssessmentInstructions("   "), undefined);
  assert.equal(parseCodeAssessmentInstructions(" Check boundary inputs. "), "Check boundary inputs.");
  assert.equal(parseCodeAssessmentInstructions("x".repeat(4000))?.length, 4000);
  for (const value of [null, {}, "x".repeat(4001)]) assert.throws(() => parseCodeAssessmentInstructions(value), /instructions/u);
});

test("comment input rejects extra fields, invalid paths, ranges and oversized text", () => {
  assert.equal(parseCreateCodeAssessmentComment(input).body, "Reviewed this edge case.");
  for (const patch of [{ snapshotDigest: "old" }, { path: "../secret" }, { path: "C:\\secret" }, { side: "both" },
    { startLine: 0 }, { startLine: 2.5 }, { endLine: 1 }, { endLine: 23 }, { body: " " }, { body: "x".repeat(4001) }, { tools: ["exec"] }]) {
    assert.throws(() => parseCreateCodeAssessmentComment({ ...input, ...patch }));
  }
});

test("snapshot anchors keep old/new sides and individual hunks separate", () => {
  const anchors = codeAssessmentSnapshotAnchors(snapshot);
  assert.deepEqual(anchors.map(({ side, startLine, endLine }) => [side, startLine, endLine]),
    [["old", 1, 2], ["new", 1, 2], ["old", 3, 3], ["new", 3, 3]]);
  assert.doesNotThrow(() => assertCodeAssessmentLineAnchor(input, snapshot));
  assert.doesNotThrow(() => assertCodeAssessmentLineAnchor({ ...input, side: "old" }, snapshot));
  for (const patch of [{ snapshotDigest: "b".repeat(64) }, { path: "other.ts" }, { endLine: 3 }, { startLine: 4, endLine: 4 }, { endLine: 1 }]) {
    assert.throws(() => assertCodeAssessmentLineAnchor({ ...input, ...patch }, snapshot));
  }
  const addition = { ...snapshot, files: [{ ...snapshot.files[0]!, diff: "@@ -0,0 +1 @@\n+new\n" }] };
  assert.deepEqual(codeAssessmentSnapshotAnchors(addition).map(anchor => anchor.side), ["new"]);
});
