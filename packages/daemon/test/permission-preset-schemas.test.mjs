import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunRequest } from "../dist/features/runs/schemas.js";
import { parseTaskRunRequest } from "../dist/features/tasks/schemas.js";

function runRequest(overrides = {}) {
  return {
    cwd: "/workspace",
    providerPresetId: "provider_openai",
    task: {
      id: "task_1",
      title: "Task",
      prompt: "Do the task",
    },
    ...overrides,
  };
}

test("run schemas derive permission mode from non-custom presets", () => {
  const run = parseRunRequest(runRequest({ permissionPreset: "workspace_collaboration" }));
  assert.equal(run.permissionPreset, "workspace_collaboration");
  assert.equal(run.permissionMode, "workspace_write");

  const taskRun = parseTaskRunRequest({
    providerPresetId: "provider_openai",
    permissionPreset: "read_only",
  });
  assert.equal(taskRun.permissionPreset, "read_only");
  assert.equal(taskRun.permissionMode, "ask_everything");
});

test("run schemas reject non-custom preset and mode mismatches", () => {
  assert.throws(
    () => parseRunRequest(runRequest({
      permissionPreset: "read_only",
      permissionMode: "workspace_write",
    })),
    /permissionPreset and permissionMode must describe the same permission scope/,
  );

  assert.throws(
    () => parseTaskRunRequest({
      providerPresetId: "provider_openai",
      permissionPreset: "workspace_collaboration",
      permissionMode: "ask_everything",
    }),
    /permissionPreset and permissionMode must describe the same permission scope/,
  );
});

test("custom preset preserves explicit legacy permission modes", () => {
  const run = parseRunRequest(runRequest({
    permissionPreset: "custom",
    permissionMode: "balanced",
  }));
  assert.equal(run.permissionPreset, "custom");
  assert.equal(run.permissionMode, "balanced");
});

test("derived full access preset still requires explicit confirmation", () => {
  assert.throws(
    () => parseRunRequest(runRequest({ permissionPreset: "full_access" })),
    /Full access runs require explicit permission confirmation/,
  );

  const confirmed = parseRunRequest(runRequest({
    permissionPreset: "full_access",
    permissionConfirmation: {
      mode: "full_access",
      confirmed: true,
      confirmedAt: "2026-06-07T00:00:00.000Z",
      reason: "Local maintenance run",
    },
  }));
  assert.equal(confirmed.permissionPreset, "full_access");
  assert.equal(confirmed.permissionMode, "full_access");
});
