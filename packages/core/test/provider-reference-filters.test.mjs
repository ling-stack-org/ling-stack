import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
  getBuiltinAutomationTemplate,
} from "../dist/index.js";

test("sqlite provider reference filters find config and active runtime references", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-provider-reference-filters-"));
  const now = "2026-06-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({
      name: "Engineering",
      boundPath: cwd,
      defaultProviderPresetId: "provider_primary",
    }, now);
    store.createChannel({
      name: "Design",
      boundPath: cwd,
      defaultProviderPresetId: "provider_secondary",
    }, now);

    store.createAiTeammate({
      roleKey: "engineer",
      displayName: "Engineer",
      description: "Builds software",
      providerPresetId: "provider_primary",
      appendSystemPrompt: [],
      allowedTools: ["read"],
      approvalProfile: { mode: "none" },
    }, now);
    store.createAiTeammate({
      roleKey: "analyst",
      displayName: "Analyst",
      description: "Reviews work",
      providerPresetId: "provider_secondary",
      appendSystemPrompt: [],
      allowedTools: ["read"],
      approvalProfile: { mode: "none" },
      status: "disabled",
      hidden: true,
    }, now);

    const thread = store.createLingThread(
      {
        kind: "automation",
        channelId: channel.id,
        title: "Daily automation thread",
        objective: "Daily brief",
      },
      now,
    );
    const dailyTemplate = getBuiltinAutomationTemplate("daily_brief");
    const automation = store.createAutomationDefinition(
      {
        channelId: channel.id,
        threadId: thread.id,
        title: "Daily Brief",
        kind: "daily_brief",
        trigger: dailyTemplate.defaultTrigger,
        target: {
          scope: "channel",
          workspaceId: DEFAULT_WORKSPACE_ID,
          channelId: channel.id,
          cwd,
        },
        promptTemplate: dailyTemplate.defaultPromptTemplate,
        executionPolicy: {
          ...dailyTemplate.defaultExecutionPolicy,
          providerPresetId: "provider_primary",
        },
        outputPolicy: dailyTemplate.defaultOutputPolicy,
      },
      now,
    );

    store.createRun({
      id: "run_provider_primary_queued",
      cwd,
      taskId: "task_queued",
      channelId: channel.id,
      providerPresetId: "provider_primary",
      providerName: "Primary",
      providerModel: "primary-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: now,
    });
    store.createRun({
      id: "run_provider_secondary_queued",
      cwd,
      taskId: "task_secondary",
      channelId: channel.id,
      providerPresetId: "provider_secondary",
      providerName: "Secondary",
      providerModel: "secondary-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: now,
    });
    store.createRun({
      id: "run_provider_primary_done",
      cwd,
      taskId: "task_done",
      channelId: channel.id,
      providerPresetId: "provider_primary",
      providerName: "Primary",
      providerModel: "primary-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: now,
    });
    store.markRunSucceeded("run_provider_primary_done", "2026-06-30T00:01:00.000Z");

    store.createWorkUnit({
      id: "wu_provider_primary",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_queued",
      channelId: channel.id,
      providerPresetId: "provider_primary",
      idempotencyKey: "wu-provider-primary",
      createdByActor: "user",
      request: {},
      now,
    });
    store.createWorkUnit({
      id: "wu_provider_secondary",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_secondary",
      channelId: channel.id,
      providerPresetId: "provider_secondary",
      idempotencyKey: "wu-provider-secondary",
      createdByActor: "user",
      request: {},
      now,
    });

    assert.deepEqual(store.listChannels({ defaultProviderPresetId: "provider_primary" }).map((item) => item.name), ["Engineering"]);
    assert.deepEqual(
      store.listAiTeammates({ includeHidden: true, includeDisabled: true, providerPresetId: "provider_primary" }).map((item) => item.displayName),
      ["Engineer"],
    );
    assert.deepEqual(store.listAutomationDefinitions({ providerPresetId: "provider_primary" }).map((item) => item.id), [automation.id]);
    assert.deepEqual(store.listRuns({ providerPresetId: "provider_primary", status: "queued" }).map((item) => item.id), ["run_provider_primary_queued"]);
    assert.deepEqual(store.listWorkUnits({ providerPresetId: "provider_primary", status: "queued" }).map((item) => item.id), ["wu_provider_primary"]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
