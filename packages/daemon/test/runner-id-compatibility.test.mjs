import assert from "node:assert/strict";
import test from "node:test";
import { parseCreateAutomationRequest } from "../dist/features/automations/schemas.js";
import { parseChannelWorkflowStepStartRequest } from "../dist/features/channels/schemas.js";
import { parseCreateAiTeammateInput } from "../dist/features/teammates/schemas.js";
import { parseRunRequest } from "../dist/features/runs/schemas.js";
import { parseTaskRunRequest } from "../dist/features/tasks/schemas.js";
import { parseRunnerReadinessRoute } from "../dist/server/routes.js";

function runRequest(overrides = {}) {
  return {
    cwd: "/workspace",
    providerPresetId: "provider_fixture",
    task: { id: "task", title: "Task", prompt: "Run it" },
    ...overrides,
  };
}

test("legacy runner aliases are canonicalized at every public request boundary", () => {
  assert.equal(parseRunRequest(runRequest({ runnerId: "pi-coding-agent" })).runnerId, "pi");
  assert.equal(parseTaskRunRequest({ providerPresetId: "provider_fixture", runnerId: "pi-coding-agent" }).runnerId, "pi");

  const teammate = parseCreateAiTeammateInput({
    roleKey: "engineer", displayName: "Builder", description: "Builds things",
    runnerId: "pi-coding-agent", approvalProfile: { mode: "none" },
  });
  assert.equal(teammate.runnerId, "pi");

  const automation = parseCreateAutomationRequest({
    kind: "custom_prompt", title: "Legacy runner automation", channelId: "channel",
    executionPolicy: { runnerId: "pi-coding-agent" },
  });
  assert.equal(automation.executionPolicy?.runnerId, "pi");

  const channelStep = parseChannelWorkflowStepStartRequest({ mode: "create_and_run_task", runnerId: "pi-coding-agent" });
  assert.equal(channelStep.runnerId, "pi");
  assert.deepEqual(parseRunnerReadinessRoute("/runners/pi-coding-agent/readiness"), { runnerId: "pi" });
});

test("runner alias and native execution binding compare by canonical identity", () => {
  const parsed = parseRunRequest(runRequest({
    runnerId: "pi-coding-agent",
    executionBinding: { kind: "pi_provider", providerPresetId: "provider_fixture" },
  }));
  assert.equal(parsed.runnerId, "pi");
});
