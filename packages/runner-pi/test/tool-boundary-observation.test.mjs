import assert from "node:assert/strict";
import test from "node:test";
import * as observation from "../dist/tool-boundary-observation.js";

test("live SDK inventory is readable only inside its original provider boundary", () => {
  const original = observation.createPiToolBoundaryObservation("run", "attempt");
  original.enter("read-1", "read");
  original.completeBuiltinRead("read-1", "read");
  original.completeTool("read-1", "read");
  assert.equal(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), undefined);
  original.enterProviderBoundary();
  assert.deepEqual(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), {
    toolCallIds: ["read-1"], settledBuiltinReads: [{ toolCallId: "read-1", toolName: "read" }],
  });
  assert.equal(observation.readPiProviderBoundaryInventory({ ...original.receipt }, "run", "attempt"), undefined);
  assert.equal(observation.readPiProviderBoundaryInventory(original.receipt, "other", "attempt"), undefined);
  assert.equal(observation.readPiCompletedToolCalls(original.receipt, "run", "attempt"), undefined,
    "a paused source is not a drained original SDK");
  original.leaveProviderBoundary();
  assert.equal(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), undefined);
  original.finish();
  assert.equal(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), undefined);
  assert.deepEqual(observation.readPiCompletedToolCalls(original.receipt, "run", "attempt"), ["read-1"]);
});

test("unfinished and mismatched SDK calls cannot provide a complete boundary inventory", () => {
  const original = observation.createPiToolBoundaryObservation("run", "attempt");
  original.enter("write-1", "write");
  original.enterProviderBoundary();
  assert.equal(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), undefined);
  original.leaveProviderBoundary();
  original.completeTool("write-1", "read");
  original.enterProviderBoundary();
  assert.equal(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), undefined);
});

test("a complete SDK write call supplies identity but never its own effect proof", () => {
  const original = observation.createPiToolBoundaryObservation("run", "attempt");
  original.enter("write-1", "write");
  original.completeTool("write-1", "write");
  original.enterProviderBoundary();
  assert.deepEqual(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), {
    toolCallIds: ["write-1"], settledBuiltinReads: [],
  });
});

test("unknown completion, repeated call IDs and nested boundaries invalidate the source", () => {
  for (const corrupt of [
    original => original.completeTool("missing", "read"),
    original => { original.enter("id", "read"); original.completeTool("id", "read"); original.enter("id", "read"); },
    original => original.enterProviderBoundary(),
  ]) {
    const original = observation.createPiToolBoundaryObservation("run", "attempt");
    corrupt(original);
    original.enterProviderBoundary();
    assert.equal(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), undefined);
  }
});
