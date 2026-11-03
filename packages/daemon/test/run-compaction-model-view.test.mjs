import assert from "node:assert/strict";
import test from "node:test";
import { compactionRecoveryMode, isValidCompactedModelView } from "../dist/features/harness/continuations/run-compaction-model-view.js";

const summary = "Host-sealed task progress.";
const prefix = [{ role: "compactionSummary", summary }, { role: "user", content: "Continue the owned task." }];
const assistant = (stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text: "Task result." }] });

test("a normal final assistant is complete; a settled tool pair must continue", () => {
  const complete = [...prefix, assistant()];
  assert.equal(isValidCompactedModelView(summary, complete), true);
  assert.equal(compactionRecoveryMode(complete), "complete");
  const continued = [...prefix, { role: "assistant", stopReason: "toolUse", content: [
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "owned.txt" } },
  ] }, { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "Owned result." }] }];
  assert.equal(isValidCompactedModelView(summary, continued), true);
  assert.equal(compactionRecoveryMode(continued), "continue");
});

for (const reason of ["aborted", "error", "length", "toolUse", "unknown", undefined]) {
  test(`a final assistant with ${String(reason)} is not a completion witness`, () => {
    const final = assistant();
    if (reason === undefined) delete final.stopReason;
    else final.stopReason = reason;
    const view = [...prefix, final];
    assert.equal(isValidCompactedModelView(summary, view), false);
    assert.equal(compactionRecoveryMode(view), undefined);
  });
}

for (const content of [undefined, "not SDK content", [{ type: "toolCall", id: "unfinished", name: "read", arguments: {} }]]) {
  test(`a stop marker cannot bless malformed or unfinished final content: ${JSON.stringify(content)}`, () => {
    const view = [...prefix, { ...assistant(), content }];
    assert.equal(isValidCompactedModelView(summary, view), false);
    assert.equal(compactionRecoveryMode(view), undefined);
  });
}
