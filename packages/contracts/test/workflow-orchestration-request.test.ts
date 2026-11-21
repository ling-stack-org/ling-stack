import assert from "node:assert/strict";
import test from "node:test";
import { parseChannelWorkflowOrchestrationRequest } from "../dist/index.js";

test("ordinary orchestration remains body-optional and isolated execution requires the exact profile", () => {
  assert.deepEqual(parseChannelWorkflowOrchestrationRequest(undefined), {});
  assert.deepEqual(parseChannelWorkflowOrchestrationRequest({}), {});
  assert.deepEqual(parseChannelWorkflowOrchestrationRequest({ executionProfile: "pi_host_isolated_files_v1" }),
    { executionProfile: "pi_host_isolated_files_v1" });
});

test("orchestration rejects unknown profiles and caller-provided delivery authority", () => {
  for (const input of [null, [], false, "pi_host_isolated_files_v1", { executionProfile: undefined },
    { executionProfile: "serial_v1" }, { executionProfile: null }, { executionProfile: "pi_host_isolated_files_v1", mode: "apply_to_target" },
    { executionProfile: "pi_host_isolated_files_v1", maxConcurrentSteps: 4 }, { command: "git merge" }]) {
    assert.throws(() => parseChannelWorkflowOrchestrationRequest(input), /explicit pi_host_isolated_files_v1 execution profile/u);
  }
});
