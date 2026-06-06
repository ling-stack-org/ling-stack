import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
  getBuiltinAutomationTemplate,
  resolveRuntimePaths,
} from "../dist/index.js";

test("sqlite automation definitions persist, filter, update, and archive without deleting runs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-automations-store-"));
  const now = "2026-06-06T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const otherChannel = store.createChannel({ name: "Design", boundPath: cwd }, now);
    const thread = store.createLingThread(
      {
        kind: "automation",
        channelId: channel.id,
        title: "Daily automation thread",
        objective: "Daily brief",
      },
      now,
    );
    const otherThread = store.createLingThread(
      {
        kind: "automation",
        channelId: otherChannel.id,
        title: "Weekly automation thread",
        objective: "Weekly review",
      },
      now,
    );

    const dailyTemplate = getBuiltinAutomationTemplate("daily_brief");
    const weeklyTemplate = getBuiltinAutomationTemplate("weekly_review");
    const daily = store.createAutomationDefinition(
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
        executionPolicy: dailyTemplate.defaultExecutionPolicy,
        outputPolicy: dailyTemplate.defaultOutputPolicy,
      },
      now,
    );
    const weekly = store.createAutomationDefinition(
      {
        channelId: otherChannel.id,
        threadId: otherThread.id,
        title: "Weekly Review",
        kind: "weekly_review",
        status: "disabled",
        trigger: weeklyTemplate.defaultTrigger,
        target: {
          scope: "channel",
          workspaceId: DEFAULT_WORKSPACE_ID,
          channelId: otherChannel.id,
          cwd,
        },
        promptTemplate: weeklyTemplate.defaultPromptTemplate,
        executionPolicy: weeklyTemplate.defaultExecutionPolicy,
        outputPolicy: weeklyTemplate.defaultOutputPolicy,
      },
      now,
    );

    assert.match(daily.id, /^automation_/);
    assert.equal(daily.status, "enabled");
    assert.equal(daily.threadId, thread.id);
    assert.equal(store.getLingThread(daily.threadId).kind, "automation");
    assert.equal(weekly.status, "disabled");
    assert.deepEqual(store.listAutomationDefinitions({ status: "enabled" }).map((item) => item.id), [daily.id]);
    assert.deepEqual(store.listAutomationDefinitions({ kind: "weekly_review" }).map((item) => item.id), [weekly.id]);
    assert.deepEqual(store.listAutomationDefinitions({ channelId: channel.id }).map((item) => item.id), [daily.id]);

    const updated = store.updateAutomationDefinition(
      daily.id,
      {
        title: "Daily Brief v2",
        trigger: {
          type: "schedule",
          timezone: "UTC",
          schedule: { cadence: "daily", timeOfDay: "09:00" },
          missedRunPolicy: "skip",
        },
        nextRunAt: "2026-06-06T09:00:00.000Z",
      },
      "2026-06-06T00:01:00.000Z",
    );
    assert.equal(updated.title, "Daily Brief v2");
    assert.equal(updated.trigger.type, "schedule");
    assert.equal(updated.nextRunAt, "2026-06-06T09:00:00.000Z");
    assert.deepEqual(store.listAutomationDefinitions({ scheduledOnly: true }).map((item) => item.id), [daily.id]);

    const automationRun = store.createAutomationRun(
      {
        automationId: daily.id,
        channelId: channel.id,
        threadId: thread.id,
        triggerType: "manual",
        idempotencyKey: "automation:daily:manual:test",
      },
      "2026-06-06T00:02:00.000Z",
    );
    const archived = store.archiveAutomationDefinition(daily.id, "2026-06-06T00:03:00.000Z");
    assert.equal(archived.status, "archived");
    assert.equal(archived.nextRunAt, undefined);
    assert.deepEqual(store.listAutomationDefinitions().map((item) => item.id), [weekly.id]);
    assert.deepEqual(store.listAutomationDefinitions({ includeArchived: true }).map((item) => item.id).sort(), [daily.id, weekly.id].sort());
    assert.equal(store.getAutomationRun(automationRun.id).automationId, daily.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite automation runs enforce idempotency and update run/artifact links", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-automation-runs-store-"));
  const now = "2026-06-06T01:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const thread = store.createLingThread(
      {
        kind: "automation",
        channelId: channel.id,
        title: "Daily automation thread",
        objective: "Daily brief",
      },
      now,
    );
    const template = getBuiltinAutomationTemplate("daily_brief");
    const automation = store.createAutomationDefinition(
      {
        channelId: channel.id,
        threadId: thread.id,
        title: "Daily Brief",
        kind: "daily_brief",
        trigger: template.defaultTrigger,
        target: {
          scope: "channel",
          workspaceId: DEFAULT_WORKSPACE_ID,
          channelId: channel.id,
          cwd,
        },
        promptTemplate: template.defaultPromptTemplate,
        executionPolicy: template.defaultExecutionPolicy,
        outputPolicy: template.defaultOutputPolicy,
      },
      now,
    );
    const automationRun = store.createAutomationRun(
      {
        automationId: automation.id,
        channelId: channel.id,
        threadId: thread.id,
        triggerType: "manual",
        idempotencyKey: "automation:daily:manual:dedupe",
      },
      "2026-06-06T01:01:00.000Z",
    );
    assert.match(automationRun.id, /^automation_run_/);
    assert.equal(automationRun.status, "queued");
    assert.deepEqual(automationRun.outputArtifactIds, []);
    assert.equal(store.findAutomationRunByIdempotencyKey("automation:daily:manual:dedupe").id, automationRun.id);
    assert.throws(
      () => store.createAutomationRun(
        {
          automationId: automation.id,
          channelId: channel.id,
          threadId: thread.id,
          triggerType: "manual",
          idempotencyKey: "automation:daily:manual:dedupe",
        },
        "2026-06-06T01:01:01.000Z",
      ),
      /idempotency key already exists/,
    );

    const run = store.createRun({
      id: "run_automation_store_test",
      cwd,
      taskId: "task_automation_store_test",
      channelId: channel.id,
      providerName: "Static",
      providerModel: "static-model",
      taskSnapshot: { id: "task_automation_store_test", title: "Daily Brief" },
      providerSnapshot: { provider: "static", model: "static-model" },
      requestSnapshot: { idempotencyKey: "automation-run:test" },
      threadId: thread.id,
      createdAt: "2026-06-06T01:02:00.000Z",
    });
    const contextArtifact = store.createArtifact({
      id: "artifact_context_preview",
      runId: run.id,
      type: "markdown",
      path: "automations/context.md",
      title: "Context preview",
      createdAt: "2026-06-06T01:02:01.000Z",
    });
    const reportArtifact = store.createArtifact({
      id: "artifact_report",
      runId: run.id,
      type: "markdown",
      path: "automations/report.md",
      title: "Report",
      createdAt: "2026-06-06T01:02:02.000Z",
    });
    const updated = store.updateAutomationRun(
      automationRun.id,
      {
        runId: run.id,
        status: "succeeded",
        startedAt: "2026-06-06T01:02:00.000Z",
        completedAt: "2026-06-06T01:03:00.000Z",
        contextPreviewArtifactId: contextArtifact.id,
        outputArtifactIds: [reportArtifact.id],
      },
      "2026-06-06T01:03:00.000Z",
    );
    assert.equal(updated.runId, run.id);
    assert.equal(updated.contextPreviewArtifactId, contextArtifact.id);
    assert.deepEqual(updated.outputArtifactIds, [reportArtifact.id]);
    assert.deepEqual(store.listAutomationRuns({ runId: run.id }).map((item) => item.id), [automationRun.id]);
    assert.deepEqual(store.listAutomationRuns({ status: "succeeded" }).map((item) => item.id), [automationRun.id]);
    assert.equal(store.getAutomationDefinition(automation.id).lastRunId, automationRun.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite automation drafts persist, validate, update, confirm, and discard", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-automation-drafts-store-"));
  const now = "2026-06-06T03:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const incomplete = store.createAutomationDraft(
      {
        source: "manual",
        channelId: channel.id,
        kind: "custom_prompt",
      },
      now,
    );
    assert.match(incomplete.id, /^automation_draft_/);
    assert.equal(incomplete.status, "needs_user_input");
    assert.deepEqual(incomplete.missingFields.sort(), ["outputPolicy", "promptTemplate", "target", "title", "trigger"].sort());

    const template = getBuiltinAutomationTemplate("daily_brief");
    const ready = store.updateAutomationDraft(
      incomplete.id,
      {
        title: "Draft Daily Brief",
        trigger: template.defaultTrigger,
        target: {
          scope: "channel",
          workspaceId: DEFAULT_WORKSPACE_ID,
          channelId: channel.id,
          cwd,
        },
        promptTemplate: template.defaultPromptTemplate,
        executionPolicy: template.defaultExecutionPolicy,
        outputPolicy: template.defaultOutputPolicy,
      },
      "2026-06-06T03:01:00.000Z",
    );
    assert.equal(ready.status, "ready_for_confirmation");
    assert.deepEqual(ready.missingFields, []);
    assert.deepEqual(store.listAutomationDrafts({ source: "manual" }).map((item) => item.id), [ready.id]);

    const thread = store.createLingThread(
      {
        kind: "automation",
        channelId: channel.id,
        title: "Draft automation thread",
        objective: "Draft Daily Brief",
      },
      "2026-06-06T03:02:00.000Z",
    );
    const automation = store.createAutomationDefinition(
      {
        channelId: channel.id,
        threadId: thread.id,
        title: "Draft Daily Brief",
        kind: "custom_prompt",
        trigger: template.defaultTrigger,
        target: {
          scope: "channel",
          workspaceId: DEFAULT_WORKSPACE_ID,
          channelId: channel.id,
          cwd,
        },
        promptTemplate: template.defaultPromptTemplate,
        executionPolicy: template.defaultExecutionPolicy,
        outputPolicy: template.defaultOutputPolicy,
      },
      "2026-06-06T03:03:00.000Z",
    );
    const confirmed = store.confirmAutomationDraft(ready.id, automation.id, "2026-06-06T03:04:00.000Z");
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.confirmedAutomationId, automation.id);
    assert.deepEqual(store.listAutomationDrafts().map((item) => item.id), []);
    assert.deepEqual(store.listAutomationDrafts({ includeTerminal: true }).map((item) => item.id), [confirmed.id]);

    const discardable = store.createAutomationDraft(
      {
        source: "chat",
        title: "Discard me",
        kind: "custom_prompt",
        trigger: { type: "manual" },
        target: {
          scope: "channel",
          workspaceId: DEFAULT_WORKSPACE_ID,
          channelId: channel.id,
          cwd,
        },
        promptTemplate: template.defaultPromptTemplate,
        outputPolicy: template.defaultOutputPolicy,
      },
      "2026-06-06T03:05:00.000Z",
    );
    const discarded = store.discardAutomationDraft(discardable.id, "2026-06-06T03:06:00.000Z");
    assert.equal(discarded.status, "discarded");
    assert.ok(discarded.discardedAt);
    assert.equal(store.confirmAutomationDraft(discarded.id, automation.id, "2026-06-06T03:07:00.000Z").status, "discarded");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite automation JSON corruption fails readably", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-automation-corrupt-json-"));
  const now = "2026-06-06T02:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const thread = store.createLingThread(
      {
        kind: "automation",
        channelId: channel.id,
        title: "Daily automation thread",
        objective: "Daily brief",
      },
      now,
    );
    const template = getBuiltinAutomationTemplate("daily_brief");
    const automation = store.createAutomationDefinition(
      {
        channelId: channel.id,
        threadId: thread.id,
        title: "Daily Brief",
        kind: "daily_brief",
        trigger: template.defaultTrigger,
        target: {
          scope: "channel",
          workspaceId: DEFAULT_WORKSPACE_ID,
          channelId: channel.id,
          cwd,
        },
        promptTemplate: template.defaultPromptTemplate,
        executionPolicy: template.defaultExecutionPolicy,
        outputPolicy: template.defaultOutputPolicy,
      },
      now,
    );
    store.close();

    const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    try {
      database
        .prepare("UPDATE automation_definitions SET trigger_json = ? WHERE id = ?")
        .run("{bad json", automation.id);
    } finally {
      database.close();
    }

    const reopened = createSqliteRunStore(cwd);
    try {
      assert.throws(
        () => reopened.getAutomationDefinition(automation.id),
        /JSON|SQLite|Expected/i,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
