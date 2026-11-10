import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRunnerIdsInSnapshot } from "../dist/runner-ids.js";
import { mapControlPlaneEvent } from "../dist/storage/sqlite/control-plane-mappers.js";
import { mapRuntimeEvent } from "../dist/storage/sqlite/runtime-work-mappers.js";
import { mapRunEvent } from "../dist/storage/sqlite/run-mappers.js";

test("runner projection normalizes identity fields but preserves user text", () => {
  const stored = {
    runnerId: "pi-coding-agent",
    nested: [{ effectiveRunnerId: "pi-coding-agent" }],
    prompt: "keep pi-coding-agent in user text",
  };
  assert.deepEqual(normalizeRunnerIdsInSnapshot(stored), {
    runnerId: "pi",
    nested: [{ effectiveRunnerId: "pi" }],
    prompt: "keep pi-coding-agent in user text",
  });
  assert.equal(stored.runnerId, "pi-coding-agent");
});

test("runtime and control-plane mappers project historical runner IDs", () => {
  const runtime = mapRuntimeEvent({
    id: "event_1", work_unit_id: "unit_1", attempt_id: null, runtime_instance_id: null,
    fencing_token: null, seq: 1, ts: "2026-10-29T00:00:00.000Z", type: "started", actor: "system",
    data_json: JSON.stringify({ runnerId: "pi-coding-agent", prompt: "keep pi-coding-agent" }),
  });
  assert.deepEqual(runtime.data, { runnerId: "pi", prompt: "keep pi-coding-agent" });

  const controlPlane = mapControlPlaneEvent({
    seq: 1, workspace_id: "workspace_default", cwd: "/workspace", ts: "2026-10-29T00:00:00.000Z",
    domain: "runs", entity_type: "run", entity_id: "run_1", action: "created",
    data_json: JSON.stringify({ effectiveRunnerId: "pi-coding-agent" }), idempotency_key: null,
  });
  assert.deepEqual(controlPlane.data, { effectiveRunnerId: "pi" });

  const runEvent = mapRunEvent({
    id: "run_event_1", run_id: "run_1", seq: 1, ts: "2026-10-29T00:00:00.000Z",
    type: "run_start", data_json: JSON.stringify({ runnerId: "pi-coding-agent" }),
  });
  assert.deepEqual(runEvent.data, { runnerId: "pi" });
});
