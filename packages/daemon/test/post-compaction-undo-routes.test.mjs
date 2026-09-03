import assert from "node:assert/strict";
import test from "node:test";
import { parseTurnRoute } from "../dist/server/routes.js";

test("post-compaction turn workspace-change routes parse only their supported shapes", () => {
  assert.deepEqual(parseTurnRoute("/turns/turn_123/workspace-changes"), {
    kind: "workspace-changes",
    turnId: "turn_123",
  });
  assert.deepEqual(parseTurnRoute("/turns/turn_123/workspace-changes/undo"), {
    kind: "workspace-changes-undo",
    turnId: "turn_123",
  });
  assert.deepEqual(parseTurnRoute("/turns/turn_123/workspace-changes/reapply"), {
    kind: "workspace-changes-reapply",
    turnId: "turn_123",
  });
});

test("post-compaction turn workspace-change routes reject malformed paths", () => {
  for (const pathname of [
    "/turns//workspace-changes",
    "/turns/turn_123/workspace-changes/unknown",
    "/turns/turn_123/workspace-changes/undo/extra",
    "/turns/%E0%A4%A/workspace-changes",
    "/runs/run_123/workspace-changes",
  ]) {
    assert.equal(parseTurnRoute(pathname), undefined, pathname);
  }
});

test("post-compaction turn route IDs are decoded once", () => {
  assert.deepEqual(parseTurnRoute("/turns/turn%2F123/workspace-changes"), {
    kind: "workspace-changes",
    turnId: "turn/123",
  });
});
