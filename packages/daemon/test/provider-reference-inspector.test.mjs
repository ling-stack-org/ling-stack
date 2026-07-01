import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatProviderDeleteBlockedMessage,
  inspectProviderReferences,
} from "../dist/features/providers/reference-inspector.js";

test("provider reference inspector reports config and active runtime blockers", () => {
  const store = createFakeReferenceStore({
    workspaceDefaultProviderId: "provider_primary",
    channels: [
      { id: "channel_engineering", name: "Engineering", status: "active", defaultProviderPresetId: "provider_primary" },
      { id: "channel_design", name: "Design", status: "active", defaultProviderPresetId: "provider_other" },
    ],
    teammates: [
      { id: "teammate_engineer", displayName: "Engineer", status: "active", providerPresetId: "provider_primary" },
      { id: "teammate_architect", displayName: "Architect", status: "disabled", providerPresetId: "provider_other" },
    ],
    automations: [
      { id: "automation_daily", title: "Daily Brief", status: "enabled", executionPolicy: { providerPresetId: "provider_primary" } },
      { id: "automation_weekly", title: "Weekly Review", status: "archived", executionPolicy: { providerPresetId: "provider_primary" } },
    ],
    runs: [
      { id: "run_queued", taskId: "task_queued", providerModel: "primary-model", status: "queued", providerPresetId: "provider_primary" },
      { id: "run_done", taskId: "task_done", providerModel: "primary-model", status: "succeeded", providerPresetId: "provider_primary" },
    ],
    workUnits: [
      { id: "wu_running", kind: "task_run", status: "running", providerPresetId: "provider_primary" },
      { id: "wu_done", kind: "task_run", status: "succeeded", providerPresetId: "provider_primary" },
    ],
    mediaJobs: [
      { id: "media_running", prompt: "Generate cover", operation: "image_generate", status: "running", providerPresetId: "provider_primary" },
      { id: "media_failed", prompt: "Old failed job", operation: "image_generate", status: "failed", providerPresetId: "provider_primary" },
    ],
  });

  const inspection = inspectProviderReferences(store, "provider_primary");

  assert.equal(inspection.canDelete, false);
  assert.deepEqual(inspection.blockers.map((blocker) => blocker.kind), [
    "workspace_default_provider",
    "channel_default_provider",
    "ai_teammate_provider",
    "automation_execution_policy",
    "active_run",
    "active_work_unit",
    "active_media_job",
  ]);
  assert.equal(inspection.blockers.find((blocker) => blocker.kind === "channel_default_provider")?.label, "Engineering");
  assert.match(formatProviderDeleteBlockedMessage(inspection), /Provider is still used by 7 item/);
  assert.match(formatProviderDeleteBlockedMessage(inspection), /Workspace default model/);
});

test("provider reference inspector ignores terminal historical runs and media jobs", () => {
  const store = createFakeReferenceStore({
    runs: [
      { id: "run_succeeded", taskId: "task_done", providerModel: "primary-model", status: "succeeded", providerPresetId: "provider_primary" },
      { id: "run_failed", taskId: "task_failed", providerModel: "primary-model", status: "failed", providerPresetId: "provider_primary" },
    ],
    workUnits: [
      { id: "wu_succeeded", kind: "task_run", status: "succeeded", providerPresetId: "provider_primary" },
      { id: "wu_cancelled", kind: "task_run", status: "cancelled", providerPresetId: "provider_primary" },
    ],
    mediaJobs: [
      { id: "media_succeeded", prompt: "Done", operation: "image_generate", status: "succeeded", providerPresetId: "provider_primary" },
      { id: "media_failed", prompt: "Failed", operation: "image_generate", status: "failed", providerPresetId: "provider_primary" },
    ],
  });

  const inspection = inspectProviderReferences(store, "provider_primary");

  assert.equal(inspection.canDelete, true);
  assert.deepEqual(inspection.blockers, []);
});

test("provider reference inspector treats stale work units as active blockers", () => {
  const store = createFakeReferenceStore({
    workUnits: [
      { id: "wu_stale", kind: "task_run", status: "stale", providerPresetId: "provider_primary" },
    ],
  });

  const inspection = inspectProviderReferences(store, "provider_primary");

  assert.equal(inspection.canDelete, false);
  assert.deepEqual(inspection.blockers.map((blocker) => blocker.kind), ["active_work_unit"]);
  assert.equal(inspection.blockers[0].status, "stale");
});

function createFakeReferenceStore(input = {}) {
  const channels = input.channels ?? [];
  const teammates = input.teammates ?? [];
  const automations = input.automations ?? [];
  const runs = input.runs ?? [];
  const workUnits = input.workUnits ?? [];
  const mediaJobs = input.mediaJobs ?? [];
  return {
    getWorkspaceSettings() {
      return { defaultProviderPresetId: input.workspaceDefaultProviderId };
    },
    listChannels(options = {}) {
      return channels.filter((channel) =>
        (!options.defaultProviderPresetId || channel.defaultProviderPresetId === options.defaultProviderPresetId) &&
        (options.archived === undefined || (options.archived ? channel.status === "archived" : channel.status !== "archived"))
      );
    },
    listAiTeammates(options = {}) {
      return teammates.filter((teammate) =>
        (!options.providerPresetId || teammate.providerPresetId === options.providerPresetId) &&
        (!options.status || teammate.status === options.status) &&
        (options.includeDisabled || teammate.status !== "disabled") &&
        (options.includeHidden || !teammate.hidden)
      );
    },
    listAutomationDefinitions(options = {}) {
      return automations.filter((automation) =>
        (!options.providerPresetId || automation.executionPolicy?.providerPresetId === options.providerPresetId) &&
        (!options.includeArchived ? automation.status !== "archived" : true)
      );
    },
    listRuns(options = {}) {
      return runs.filter((run) =>
        (!options.providerPresetId || run.providerPresetId === options.providerPresetId) &&
        (!options.status || run.status === options.status)
      );
    },
    listWorkUnits(options = {}) {
      return workUnits.filter((workUnit) =>
        (!options.providerPresetId || workUnit.providerPresetId === options.providerPresetId) &&
        (!options.status || workUnit.status === options.status)
      );
    },
    listMediaJobs(options = {}) {
      return mediaJobs.filter((mediaJob) =>
        (!options.providerPresetId || mediaJob.providerPresetId === options.providerPresetId) &&
        (!options.status || mediaJob.status === options.status)
      );
    },
  };
}
