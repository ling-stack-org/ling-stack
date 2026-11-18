import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationDefinition, AutomationSchedulerState } from "@ling-stack/contracts";
import { buildAutomationMonitorViewModels } from "../src/features/automations/automation-view-models.ts";

const now = "2026-11-18T00:00:00.000Z";
const monitor = {
  id: "automation-monitor",
  workspaceId: "workspace",
  threadId: "thread",
  automationMode: "cron",
  title: "Runtime monitor",
  kind: "project_monitor",
  status: "enabled",
  cwds: [],
  trigger: {
    type: "monitor",
    pollIntervalMs: 1_000,
    source: { kind: "runtime_stuck_work" },
    condition: { kind: "error_present" },
    unchangedPolicy: "skip",
  },
  target: { scope: "workspace", workspaceId: "workspace" },
  promptTemplate: { templateVersion: 1, promptMarkdown: "Inspect", contextSelectors: [] },
  executionPolicy: {},
  outputPolicy: { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
  createdAt: now,
  updatedAt: now,
} as AutomationDefinition;

const translate = (value: string): string => value;

test("monitor projection exposes finding and waiting states from scheduler items", () => {
  const scheduler = {
    id: "scheduler",
    cwd: "/workspace",
    status: "running",
    startedAt: now,
    automationCount: 1,
    tickCount: 2,
    items: [{
      automationId: monitor.id,
      title: monitor.title,
      lastRunAt: now,
      lastAutomationRunId: "automation-run",
      lastMonitorFingerprint: "a".repeat(64),
      lastMonitorOutcome: "changed",
    }],
  } as AutomationSchedulerState;
  const finding = buildAutomationMonitorViewModels({ automations: [monitor], scheduler, t: translate });
  assert.equal(finding[0]?.statusLabel, "Monitor changed");
  assert.equal(finding[0]?.summary, "Monitor finding detected");
  assert.equal(finding[0]?.sourceLabel, "runtime_stuck_work");
  assert.equal(finding[0]?.lastAutomationRunId, "automation-run");

  const waiting = buildAutomationMonitorViewModels({ automations: [monitor], t: translate });
  assert.equal(waiting[0]?.statusLabel, "Monitor run");
  assert.equal(waiting[0]?.summary, "Waiting for first monitor poll.");
});
