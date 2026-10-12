import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { SqliteAutomationStore } from "../dist/storage/sqlite/automation-store.js";

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

    const confirmation = store.confirmAutomationDraft(ready, "2026-06-06T03:04:00.000Z");
    assert.equal(confirmation.outcome, "created");
    const { draft: confirmed, automation, thread } = confirmation;
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.confirmedAutomationId, automation.id);
    assert.equal(automation.threadId, thread.id);
    const unrelated = store.createAutomationDefinition({ ...automation, id: undefined, title: "Unrelated automation" }, "2026-06-06T03:04:01.000Z");
    const retry = store.confirmAutomationDraft({ ...ready, confirmedAutomationId: unrelated.id }, "2026-06-06T03:04:02.000Z");
    assert.equal(retry.outcome, "already_confirmed");
    const repeated = retry.draft;
    assert.equal(repeated.confirmedAutomationId, automation.id, "a confirmed draft must never be rebound to another definition");
    assert.equal(repeated.updatedAt, confirmed.updatedAt, "an idempotent retry must preserve the original confirmation fact");
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
    assert.deepEqual(store.discardAutomationDraft(discarded.id, "2026-06-06T03:06:30.000Z"), discarded);
    const rejected = store.confirmAutomationDraft(discardable, "2026-06-06T03:07:00.000Z");
    assert.equal(rejected.outcome, "not_ready");
    assert.equal(rejected.draft.status, "discarded");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const collision of ["thread", "definition"]) {
  test(`A08 sqlite confirmation refuses a pre-existing ${collision} at the draft-derived source identity`, async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-a08-source-identity-"));
    const store = createSqliteRunStore(cwd);
    const now = "2026-10-12T00:00:00.000Z";
    try {
      const template = getBuiltinAutomationTemplate("daily_brief");
      const draft = store.createAutomationDraft({ source: "manual", title: "Owned draft", kind: "custom_prompt",
        trigger: { type: "manual" }, target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd },
        promptTemplate: template.defaultPromptTemplate, executionPolicy: template.defaultExecutionPolicy,
        outputPolicy: template.defaultOutputPolicy }, now);
      const source = createHash("sha256").update(draft.id).digest("hex");
      const thread = store.createLingThread({
        id: collision === "thread" ? `thread_from_automation_draft_${source}` : undefined,
        kind: "automation", title: "Unrelated source", objective: "Do not adopt this row" }, now);
      const foreign = collision === "definition" ? store.createAutomationDefinition({
        id: `automation_from_draft_${source}`, threadId: thread.id, title: "Unrelated source", kind: "custom_prompt",
        trigger: { type: "manual" }, target: draft.target, promptTemplate: template.defaultPromptTemplate,
        executionPolicy: template.defaultExecutionPolicy, outputPolicy: template.defaultOutputPolicy }, now) : undefined;
      const result = store.confirmAutomationDraft(draft, "2026-10-12T00:01:00.000Z");
      assert.equal(result.outcome, "source_identity_conflict");
      assert.equal(store.getAutomationDraft(draft.id).status, "ready_for_confirmation");
      assert.equal(store.listLingThreads({ kind: "automation" }).length, 1);
      assert.deepEqual(store.getLingThread(thread.id), thread);
      assert.equal(store.listAutomationDefinitions({ includeArchived: true }).length, foreign ? 1 : 0);
      if (foreign) assert.deepEqual(store.getAutomationDefinition(foreign.id), foreign);
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("A08 sqlite confirmation reuses the original source across connections and rejects a foreign confirmed thread", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-a08-source-retry-"));
  const store = createSqliteRunStore(cwd);
  const peer = createSqliteRunStore(cwd);
  const now = "2026-10-12T00:00:00.000Z";
  try {
    const template = getBuiltinAutomationTemplate("daily_brief");
    const draft = store.createAutomationDraft({ source: "manual", title: "Owned draft", kind: "custom_prompt",
      trigger: { type: "manual" }, target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd },
      promptTemplate: template.defaultPromptTemplate, executionPolicy: template.defaultExecutionPolicy,
      outputPolicy: template.defaultOutputPolicy }, now);
    const peerSnapshot = peer.getAutomationDraft(draft.id);
    // Semantically identical JSON with reordered keys is the same approval snapshot.
    const reordered = Object.fromEntries(Object.entries(draft).reverse());
    const first = store.confirmAutomationDraft(reordered, "2026-10-12T00:01:00.000Z");
    assert.equal(first.outcome, "created");
    const retry = peer.confirmAutomationDraft(peerSnapshot, "2026-10-12T00:02:00.000Z");
    assert.equal(retry.outcome, "already_confirmed");
    assert.deepEqual(retry.draft, first.draft);
    assert.deepEqual(retry.automation, first.automation);
    assert.deepEqual(retry.thread, first.thread);
    assert.equal(store.listAutomationDefinitions({ includeArchived: true }).length, 1);
    assert.equal(store.listLingThreads({ kind: "automation" }).length, 1);
    const foreign = store.createLingThread({ kind: "automation", title: "Foreign thread", objective: "Do not adopt" }, now);
    store.updateAutomationDefinition(first.automation.id, { threadId: foreign.id }, now);
    const rejected = peer.confirmAutomationDraft(peerSnapshot, "2026-10-12T00:03:00.000Z");
    assert.equal(rejected.outcome, "confirmed_state_invalid");
    assert.equal(store.getAutomationDraft(draft.id).confirmedAutomationId, first.automation.id);
    assert.equal(store.listAutomationDefinitions({ includeArchived: true }).length, 1);
    assert.equal(store.listLingThreads({ kind: "automation" }).length, 2);
  } finally {
    peer.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const operation of ["update", "discard"]) {
  test(`A08 sqlite ${operation} that read ready cannot overwrite another connection's committed confirmation`, async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-a08-reverse-writer-"));
    const store = createSqliteRunStore(cwd);
    const peer = createSqliteRunStore(cwd);
    const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    const now = "2026-10-13T00:00:00.000Z";
    let confirmation;
    let observedRealReadyRow = false;
    let intercepted = false;
    try {
      const template = getBuiltinAutomationTemplate("daily_brief");
      const draft = store.createAutomationDraft({ source: "manual", title: "Immutable confirmation source", kind: "custom_prompt",
        trigger: { type: "manual" }, target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd },
        promptTemplate: template.defaultPromptTemplate, executionPolicy: template.defaultExecutionPolicy,
        outputPolicy: template.defaultOutputPolicy }, now);
      const peerSnapshot = peer.getAutomationDraft(draft.id);
      const observedDatabase = new Proxy(database, {
        get(target, property) {
          if (property === "prepare") return (sql) => {
            const statement = target.prepare(sql);
            if (!sql.includes("FROM automation_drafts")) return statement;
            return new Proxy(statement, {
              get(statementTarget, method) {
                if (method === "get") return (...args) => {
                  const row = statementTarget.get(...args);
                  if (!intercepted && args[0] === draft.id) {
                    intercepted = true;
                    observedRealReadyRow = row?.status === "ready_for_confirmation" && row?.confirmed_automation_id === null;
                    // The returned row is the untouched real SQLite snapshot. A distinct real
                    // connection commits after SELECT finishes, before the original writer resumes.
                    confirmation = peer.confirmAutomationDraft(peerSnapshot, "2026-10-13T00:01:00.000Z");
                    assert.equal(confirmation.outcome, "created");
                  }
                  return row;
                };
                const value = Reflect.get(statementTarget, method);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const writer = new SqliteAutomationStore({ database: observedDatabase }, {
        createLingThread: store.createLingThread.bind(store),
        getLingThread: store.getLingThread.bind(store),
        getChannel: store.getChannel.bind(store),
      });
      const result = operation === "update"
        ? writer.updateAutomationDraft(draft.id, { title: "Stale writer must not replace confirmed content" }, "2026-10-13T00:02:00.000Z")
        : writer.discardAutomationDraft(draft.id, "2026-10-13T00:02:00.000Z");
      assert.equal(intercepted, true);
      assert.equal(observedRealReadyRow, true);
      assert.deepEqual({ returnedStatus: result.status, durableStatus: store.getAutomationDraft(draft.id).status,
        pointer: store.getAutomationDraft(draft.id).confirmedAutomationId },
      { returnedStatus: "confirmed", durableStatus: "confirmed", pointer: confirmation.automation.id });
      assert.deepEqual(result, confirmation.draft);
      assert.deepEqual(store.getAutomationDraft(draft.id), confirmation.draft);
      assert.equal(store.listAutomationDefinitions({ includeArchived: true }).length, 1);
      assert.equal(store.listLingThreads({ kind: "automation" }).length, 1);
      assert.deepEqual(peer.confirmAutomationDraft(peerSnapshot, "2026-10-13T00:03:00.000Z").draft, confirmation.draft);
    } finally {
      database.close();
      peer.close();
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("A08 sqlite legacy confirmed facts remain readable but cannot be silently migrated or rebound on retry", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-a08-legacy-confirmed-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-10-12T00:00:00.000Z";
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  try {
    const template = getBuiltinAutomationTemplate("daily_brief");
    const draft = store.createAutomationDraft({ source: "manual", title: "Legacy draft", kind: "custom_prompt",
      trigger: { type: "manual" }, target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd },
      promptTemplate: template.defaultPromptTemplate, executionPolicy: template.defaultExecutionPolicy,
      outputPolicy: template.defaultOutputPolicy }, now);
    const thread = store.createLingThread({ kind: "automation", title: "Legacy draft", objective: template.defaultPromptTemplate.promptMarkdown }, now);
    const definition = store.createAutomationDefinition({ threadId: thread.id, title: "Legacy draft", kind: "custom_prompt",
      trigger: draft.trigger, target: draft.target, promptTemplate: draft.promptTemplate,
      executionPolicy: draft.executionPolicy, outputPolicy: draft.outputPolicy }, now);
    database.prepare("UPDATE automation_drafts SET status = 'confirmed', confirmed_automation_id = ? WHERE id = ?").run(definition.id, draft.id);
    const historical = store.getAutomationDraft(draft.id);
    const rejected = store.confirmAutomationDraft(historical, "2026-10-12T00:01:00.000Z");
    assert.equal(rejected.outcome, "confirmed_state_invalid");
    assert.deepEqual(store.getAutomationDraft(draft.id), historical);
    assert.deepEqual(store.getAutomationDefinition(definition.id), definition);
    assert.deepEqual(store.getLingThread(thread.id), thread);
    assert.equal(store.listAutomationDefinitions({ includeArchived: true }).length, 1);
    assert.equal(store.listLingThreads({ kind: "automation" }).length, 1);
  } finally {
    database.close();
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
