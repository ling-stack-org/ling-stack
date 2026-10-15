import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionLoopDetector } from "../dist/features/runs/execution-loop-detector.js";

// Synthetic memory-bound controls, not real Runner/Host execution evidence.
// TypeScript's private map is inspected solely to verify the explicit retained
// entry cap; no new product API or test-only execution permission is introduced.
for (const type of ["tool_start", "tool_update"]) {
  test(`A24 ${type} fallback retains at most the configured tracked-call count`, () => {
    const detector = new ExecutionLoopDetector("attempt-bounded-tracking", {
      maxTrackedToolCalls: 2, noProgressActionBudget: 20, repeatedUpdateThreshold: 20,
    });
    for (let index = 0; index < 5; index++) {
      const data = { toolCallId: `call-${index}`, toolName: "unknown-tool",
        ...(type === "tool_start" ? { args: { item: index } } : { partialResult: { text: `content-${index}` } }) };
      assert.equal(detector.observe({ type, data, seq: index + 1 }), undefined);
      assert.ok(detector.toolCalls instanceof Map, "inspect the actual attempt-local retained state, not a size spy");
      assert.ok(detector.toolCalls.size <= 2, `${type} retained ${detector.toolCalls.size} entries at event ${index + 1}`);
    }
    assert.deepEqual([...detector.toolCalls.keys()], ["call-3", "call-4"]);
  });
}
