import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { computeNextRunAt, computeNextRunAtFromRRule } from "../dist/features/automations/scheduler.js";
import { prepareChannelCreateBody } from "./conversation-model-test-fixture.mjs";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

test("automation API creates templates, previews context, runs once, deduplicates, and blocks disabled or archived definitions", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-automations-api-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const channel = (await createChannel(daemon.url, cwd, { defaultProviderPresetId: provider.id })).channel;
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/brief?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Ship automations",
      scope: "P0 and P1",
      acceptanceCriteria: ["Daily brief previews context", "Manual run creates evidence"],
      updatedBy: "local-user",
    });

    const daily = await postJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`, {
      kind: "daily_brief",
      title: "Daily Brief",
      channelId: channel.id,
      trigger: { type: "manual" },
    });
    assert.equal(daily.automation.kind, "daily_brief");
    assert.equal(daily.automation.status, "enabled");
    assert.equal(daily.thread.kind, "automation");
    assert.equal(daily.thread.channelId, channel.id);

    const weekly = await postJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`, {
      kind: "weekly_review",
      title: "Weekly Review",
      channelId: channel.id,
      trigger: { type: "manual" },
    });
    assert.equal(weekly.automation.kind, "weekly_review");

    const projectMonitor = await requestJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: {
        kind: "project_monitor",
        title: "Project Monitor",
        channelId: channel.id,
      },
    });
    assert.equal(projectMonitor.status, 400);
    assert.match(projectMonitor.body.message, /project_monitor_not_implemented/);

    const preview = await postJson(`${daemon.url}/automations/${encodeURIComponent(daily.automation.id)}/preview?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(preview.automation.id, daily.automation.id);
    assert.match(preview.context.contextMarkdown, /Ship automations/);
    assert.equal(runner.runs.length, 0);
    const runsBeforeManualRun = await getJson(`${daemon.url}/automation-runs?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runsBeforeManualRun.automationRuns.length, 0);

    const firstRun = await postJson(`${daemon.url}/automations/${encodeURIComponent(daily.automation.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "automation:daily:test-slot",
    });
    assert.ok(["running", "succeeded"].includes(firstRun.automationRun.status));
    assert.equal(firstRun.automationRun.threadId, daily.thread.id);
    assert.ok(firstRun.automationRun.runId);
    assert.ok(firstRun.automationRun.contextPreviewArtifactId);
    assert.equal(firstRun.run.threadId, daily.thread.id);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["read", "grep", "find", "ls"]);
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /cannot grant tools/.test(line)));
    assert.match(runner.runs[0].task.prompt, /Ship automations/);

    await waitForCondition(async () => {
      const detail = await getJson(`${daemon.url}/automation-runs/${encodeURIComponent(firstRun.automationRun.id)}?cwd=${encodeURIComponent(cwd)}`);
      return detail.automationRun.status === "succeeded";
    }, "manual automation run to finish");
    const detail = await getJson(`${daemon.url}/automation-runs/${encodeURIComponent(firstRun.automationRun.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.automationRun.status, "succeeded");
    assert.equal(detail.run.status, "succeeded");
    assert.equal(detail.run.requestSnapshot.approvalProfile.mode, "none");
    const artifacts = await getJson(`${daemon.url}/runs/${encodeURIComponent(detail.run.id)}/artifacts?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(artifacts.artifacts.some((artifact) => artifact.id === detail.automationRun.contextPreviewArtifactId));
    const contextContent = await getText(`${daemon.url}/artifacts/${encodeURIComponent(detail.automationRun.contextPreviewArtifactId)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.match(contextContent, /Automation Context Preview/);
    assert.match(contextContent, /Ship automations/);

    const duplicate = await postJson(`${daemon.url}/automations/${encodeURIComponent(daily.automation.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "automation:daily:test-slot",
    });
    assert.equal(duplicate.automationRun.id, firstRun.automationRun.id);
    assert.equal(runner.runs.length, 1);

    const disabled = await patchJson(`${daemon.url}/automations/${encodeURIComponent(daily.automation.id)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "disabled",
    });
    assert.equal(disabled.automation.status, "disabled");
    const disabledRun = await requestJson(`${daemon.url}/automations/${encodeURIComponent(daily.automation.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: {},
    });
    assert.equal(disabledRun.status, 409);
    assert.equal(disabledRun.body.error, "automation_not_runnable");

    const archived = await requestJson(`${daemon.url}/automations/${encodeURIComponent(weekly.automation.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.automation.status, "archived");
    const archivedRun = await requestJson(`${daemon.url}/automations/${encodeURIComponent(weekly.automation.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: {},
    });
    assert.equal(archivedRun.status, 409);
    assert.equal(archivedRun.body.error, "automation_not_runnable");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automation draft API persists template/manual/chat proposals and confirms idempotently", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-automation-drafts-api-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const channel = (await createChannel(daemon.url, cwd, { defaultProviderPresetId: provider.id })).channel;
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/brief?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Review automation drafts",
      scope: "P1.5",
      acceptanceCriteria: ["Draft preview uses channel context", "Confirm creates automation once"],
      updatedBy: "local-user",
    });

    const listed = await getJson(`${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(listed.templates.length >= 8);
    assert.ok(listed.templates.some((template) => template.id === "ci_failure_summary"));
    assert.equal(listed.drafts.length, 0);

    const templateDraft = await postJson(`${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`, {
      source: "template",
      templateId: "ci_failure_summary",
      partialAutomation: { channelId: channel.id },
    });
    assert.equal(templateDraft.draft.source, "template");
    assert.equal(templateDraft.draft.kind, "custom_prompt");
    assert.equal(templateDraft.draft.status, "ready_for_confirmation");
    assert.equal(templateDraft.draft.confirmedAutomationId, undefined);

    const automationsBeforeConfirm = await getJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(automationsBeforeConfirm.automations.length, 0);

    const preview = await postJson(`${daemon.url}/automation-drafts/${encodeURIComponent(templateDraft.draft.id)}/preview?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(preview.draft.id, templateDraft.draft.id);
    assert.match(preview.context.contextMarkdown, /Review automation drafts/);
    assert.equal(runner.runs.length, 0);
    const runsBeforeConfirm = await getJson(`${daemon.url}/automation-runs?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runsBeforeConfirm.automationRuns.length, 0);

    const confirmed = await postJson(`${daemon.url}/automation-drafts/${encodeURIComponent(templateDraft.draft.id)}/confirm?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(confirmed.draft.status, "confirmed");
    assert.equal(confirmed.draft.confirmedAutomationId, confirmed.automation.id);
    assert.equal(confirmed.automation.title, "CI Failure Summary");
    assert.equal(confirmed.thread.kind, "automation");

    const repeated = await postJson(`${daemon.url}/automation-drafts/${encodeURIComponent(templateDraft.draft.id)}/confirm?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(repeated.automation.id, confirmed.automation.id);
    const automationsAfterRepeat = await getJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(automationsAfterRepeat.automations.length, 1);

    const manualDraft = await postJson(`${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`, {
      source: "manual",
      partialAutomation: { kind: "custom_prompt" },
    });
    assert.equal(manualDraft.draft.status, "needs_user_input");
    assert.ok(manualDraft.draft.missingFields.includes("title"));

    const chatDraft = await postJson(`${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`, {
      source: "chat",
      prompt: "Create a daily automation that summarizes recent runs and approvals.",
      partialAutomation: { channelId: channel.id },
    });
    assert.equal(chatDraft.draft.source, "chat");
    assert.equal(chatDraft.draft.status, "ready_for_confirmation");
    assert.equal(chatDraft.draft.trigger.type, "schedule");
    assert.equal(chatDraft.draft.trigger.schedule.cadence, "daily");
    const minuteChatDraft = await postJson(`${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`, {
      source: "chat",
      prompt: "每分钟给我发一下你好",
      partialAutomation: { channelId: channel.id },
    });
    assert.equal(minuteChatDraft.draft.source, "chat");
    assert.equal(minuteChatDraft.draft.status, "ready_for_confirmation");
    assert.equal(minuteChatDraft.draft.trigger.type, "schedule");
    assert.equal(minuteChatDraft.draft.trigger.schedule.cadence, "interval");
    assert.equal(minuteChatDraft.draft.trigger.schedule.everyMs, 60_000);
    const twoHourChatDraft = await postJson(`${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`, {
      source: "chat",
      prompt: "每2小时检查一次最近运行状态",
      partialAutomation: { channelId: channel.id },
    });
    assert.equal(twoHourChatDraft.draft.trigger.type, "schedule");
    assert.equal(twoHourChatDraft.draft.trigger.schedule.cadence, "interval");
    assert.equal(twoHourChatDraft.draft.trigger.schedule.everyMs, 2 * 60 * 60_000);
    const timedDailyChatDraft = await postJson(`${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`, {
      source: "chat",
      prompt: "每天晚上8:30给我总结今天的运行",
      partialAutomation: { channelId: channel.id },
    });
    assert.equal(timedDailyChatDraft.draft.trigger.type, "schedule");
    assert.equal(timedDailyChatDraft.draft.trigger.schedule.cadence, "daily");
    assert.equal(timedDailyChatDraft.draft.trigger.schedule.timeOfDay, "20:30");
    const weeklyChatDraft = await postJson(`${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`, {
      source: "chat",
      prompt: "每周一上午9点生成项目周报",
      partialAutomation: { channelId: channel.id },
    });
    assert.equal(weeklyChatDraft.draft.trigger.type, "schedule");
    assert.equal(weeklyChatDraft.draft.trigger.schedule.cadence, "weekly");
    assert.equal(weeklyChatDraft.draft.trigger.schedule.weekday, 1);
    assert.equal(weeklyChatDraft.draft.trigger.schedule.timeOfDay, "09:00");
    const automationsAfterChatDraft = await getJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(automationsAfterChatDraft.automations.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automation scheduler auto-restores, deduplicates registration, fires scheduled automations, ignores disabled definitions, and stops timers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-automations-scheduler-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const channel = (await createChannel(daemon.url, cwd, { defaultProviderPresetId: provider.id })).channel;
    const scheduled = await postJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`, {
      kind: "daily_brief",
      title: "Interval Brief",
      channelId: channel.id,
      trigger: {
        type: "schedule",
        timezone: "UTC",
        schedule: { cadence: "interval", everyMs: 3000 },
        missedRunPolicy: "skip",
      },
    });
    await postJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`, {
      kind: "weekly_review",
      title: "Disabled Interval Review",
      channelId: channel.id,
      status: "disabled",
      trigger: {
        type: "schedule",
        timezone: "UTC",
        schedule: { cadence: "interval", everyMs: 1000 },
        missedRunPolicy: "skip",
      },
    });

    const restored = await getJson(`${daemon.url}/automations/scheduler?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(restored.schedulers.length, 1);
    assert.equal(restored.schedulers[0].status, "running");
    assert.equal(restored.schedulers[0].automationCount, 1);
    assert.equal(restored.schedulers[0].items[0].automationId, scheduled.automation.id);
    assert.ok(restored.schedulers[0].nextRunAt);

    const duplicate = await postJson(`${daemon.url}/automations/scheduler/start?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.scheduler.id, restored.schedulers[0].id);

    const listed = await getJson(`${daemon.url}/automations/scheduler?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.schedulers.length, 1);
    assert.equal(listed.schedulers[0].id, restored.schedulers[0].id);

    await waitForCondition(() => runner.runs.length === 1, "scheduled automation fire", 6000);
    const stopped = await postJson(`${daemon.url}/automations/scheduler/stop?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(stopped.scheduler.status, "stopped");

    const automationRuns = await getJson(`${daemon.url}/automation-runs?cwd=${encodeURIComponent(cwd)}&automationId=${encodeURIComponent(scheduled.automation.id)}`);
    assert.equal(automationRuns.automationRuns.length, 1);
    assert.equal(automationRuns.automationRuns[0].triggerType, "schedule");
    assert.ok(automationRuns.automationRuns[0].scheduledFor);

    await sleep(3300);
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automation scheduler computes timezone next runs without burst backfill", () => {
  assert.equal(
    computeNextRunAt(
      { cadence: "daily", timeOfDay: "09:00" },
      "Asia/Shanghai",
      new Date("2026-06-06T00:30:00.000Z"),
    ),
    "2026-06-06T01:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt(
      { cadence: "daily", timeOfDay: "09:00" },
      "Asia/Shanghai",
      new Date("2026-06-06T01:30:00.000Z"),
    ),
    "2026-06-07T01:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt(
      { cadence: "weekly", weekday: 1, timeOfDay: "10:15" },
      "Asia/Shanghai",
      new Date("2026-06-06T00:00:00.000Z"),
    ),
    "2026-06-08T02:15:00.000Z",
  );
  assert.equal(
    computeNextRunAt(
      { cadence: "interval", everyMs: 1500 },
      "UTC",
      new Date("2026-06-06T00:00:00.000Z"),
    ),
    "2026-06-06T00:00:01.500Z",
  );
  assert.equal(
    computeNextRunAtFromRRule(
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      "Asia/Shanghai",
      new Date("2026-06-06T00:00:00.000Z"),
    ),
    "2026-06-08T01:00:00.000Z",
  );
  assert.equal(
    computeNextRunAtFromRRule(
      "FREQ=DAILY;BYHOUR=15;BYMINUTE=30;BYSECOND=0",
      "Asia/Shanghai",
      new Date("2026-06-06T06:00:00.000Z"),
    ),
    "2026-06-06T07:30:00.000Z",
  );
});

test("automation scheduler records readable errors when a scheduled automation cannot start", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-automations-scheduler-error-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    simulateLegacyChannelWithoutModel(cwd, channel.id);
    const scheduled = await postJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`, {
      kind: "daily_brief",
      title: "Providerless Interval Brief",
      channelId: channel.id,
      trigger: {
        type: "schedule",
        timezone: "UTC",
        schedule: { cadence: "interval", everyMs: 1000 },
        missedRunPolicy: "skip",
      },
    });

    const started = await postJson(`${daemon.url}/automations/scheduler/start?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(started.scheduler.status, "running");

    await waitForCondition(async () => {
      const listed = await getJson(`${daemon.url}/automations/scheduler?cwd=${encodeURIComponent(cwd)}`);
      return Boolean(listed.schedulers[0]?.lastErrorMessage);
    }, "scheduled automation error to be recorded");
    const listed = await getJson(`${daemon.url}/automations/scheduler?cwd=${encodeURIComponent(cwd)}`);
    assert.match(listed.schedulers[0].lastErrorMessage, /provider preset/i);
    assert.match(listed.schedulers[0].items[0].lastErrorMessage, /provider preset/i);
    const detail = await getJson(`${daemon.url}/automations/${encodeURIComponent(scheduled.automation.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.automation.status, "error");
    assert.match(detail.automation.lastErrorMessage, /provider preset/i);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("A09 HTTP create and draft inputs reject unsupported RRULE without persisting definitions", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-a09-rrule-api-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const collection = `${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`;
    const input = { kind: "daily_brief", title: "A09 recurrence", channelId: channel.id,
      status: "paused", trigger: { type: "schedule", timezone: "UTC",
        schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" } };
    for (const rrule of ["FREQ=DAILY;COUNT=2", "FREQ=DAILY;INTERVAL=2x",
      "FREQ=WEEKLY;BYDAY=1MO", "FREQ=MINUTELY;BYHOUR=9", "FREQ=DAILY;FREQ=WEEKLY"]) {
      await t.test(`reject create ${rrule}`, async () => {
        const before = await getJson(collection);
        const rejected = await requestJson(collection, { method: "POST", body: { ...input, rrule } });
        assert.equal(rejected.status, 400);
        assert.match(rejected.body.message, /rrule/i);
        assert.deepEqual((await getJson(collection)).automations, before.automations);
      });
    }
    await t.test("reject invalid draft create before insertion", async () => {
      const drafts = `${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`;
      const before = await getJson(drafts);
      const rejected = await requestJson(drafts, { method: "POST", body: {
        source: "manual", partialAutomation: { ...input, rrule: "FREQ=DAILY;UNTIL=20261231T090000Z" },
      } });
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.message, /rrule/i);
      assert.deepEqual((await getJson(drafts)).drafts, before.drafts);
    });
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("A09 HTTP RRULE update rejects unsupported rules and preserves omitted versus cleared values", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-a09-rrule-update-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const rrule = "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
    const created = await postJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`, {
      kind: "daily_brief", title: "A09 valid rule", channelId: channel.id, status: "paused", rrule,
      trigger: { type: "schedule", timezone: "UTC", schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" },
    });
    const item = `${daemon.url}/automations/${encodeURIComponent(created.automation.id)}?cwd=${encodeURIComponent(cwd)}`;
    await t.test("invalid update does not mutate durable rule", async () => {
      const before = await getJson(item);
      const rejected = await requestJson(item, { method: "PATCH", body: { rrule: "FREQ=DAILY;COUNT=2" } });
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.message, /rrule/i);
      assert.deepEqual((await getJson(item)).automation, before.automation);
    });
    // Restore the valid rule even on the old RED implementation, so the
    // omitted/cleared assertions are independent from the rejected-update case.
    await patchJson(item, { rrule });
    assert.equal((await patchJson(item, { title: "Renamed without resetting phase" })).automation.rrule, rrule);
    assert.equal((await patchJson(item, { rrule: null })).automation.rrule,
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0");
    const drafts = `${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`;
    const draft = await postJson(drafts, { source: "manual", partialAutomation: {
      kind: "daily_brief", title: "A09 editable draft", channelId: channel.id, rrule,
    } });
    await t.test("invalid draft update does not mutate durable draft", async () => {
      const draftItem = `${daemon.url}/automation-drafts/${encodeURIComponent(draft.draft.id)}?cwd=${encodeURIComponent(cwd)}`;
      const before = await getJson(draftItem);
      const rejected = await requestJson(draftItem, { method: "PATCH", body: { partialAutomation: { rrule: "FREQ=MINUTELY;WKST=MO" } } });
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.message, /rrule/i);
      assert.deepEqual((await getJson(draftItem)).draft, before.draft);
    });
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("A09 HTTP trigger-only updates do not freeze derived RRULE during real scheduler refresh", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-a09-rrule-refresh-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  let database;
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const schedule = (timeOfDay) => ({ type: "schedule", timezone: "UTC",
      schedule: { cadence: "daily", timeOfDay }, missedRunPolicy: "skip" });
    const firstHour = (new Date().getUTCHours() + 2) % 24;
    const secondHour = (firstHour + 1) % 24;
    const firstTime = `${String(firstHour).padStart(2, "0")}:15`;
    const secondTime = `${String(secondHour).padStart(2, "0")}:45`;
    const created = await postJson(`${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`, {
      kind: "daily_brief", title: "A09 derived live schedule", channelId: channel.id, trigger: schedule(firstTime),
    });
    const item = `${daemon.url}/automations/${encodeURIComponent(created.automation.id)}?cwd=${encodeURIComponent(cwd)}`;
    database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    const stored = () => database.prepare("SELECT rrule, created_at, next_run_at FROM automation_definitions WHERE id = ?").get(created.automation.id);
    const expectedSlot = (hour, minute) => {
      const now = new Date();
      const due = new Date(now);
      due.setUTCHours(hour, minute, 0, 0);
      if (due <= now) due.setUTCDate(due.getUTCDate() + 1);
      return due.toISOString();
    };
    assert.equal(stored().rrule, null);
    await postJson(`${daemon.url}/automations/scheduler/start?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(stored().rrule, null, "scheduler nextRunAt must not author an explicit rule");
    assert.equal(stored().next_run_at, expectedSlot(firstHour, 15));
    await patchJson(item, { title: "A09 title edit preserves raw rule provenance" });
    assert.equal(stored().rrule, null);
    const changed = await patchJson(item, { trigger: schedule(secondTime) });
    assert.equal(changed.automation.rrule, `FREQ=DAILY;BYHOUR=${secondHour};BYMINUTE=45;BYSECOND=0`);
    assert.equal(stored().rrule, null);
    assert.equal(stored().next_run_at, expectedSlot(secondHour, 45));
    assert.equal(stored().created_at, created.automation.createdAt);
    const listed = await getJson(`${daemon.url}/automations/scheduler?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.schedulers[0].items.find((entry) => entry.automationId === created.automation.id).nextRunAt, stored().next_run_at);
    assert.equal((await getJson(item)).automation.rrule, changed.automation.rrule);
    assert.equal(runner.runs.length, 0);
  } finally {
    database?.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("A09 HTTP rejects uncomputable schedules before creating or mutating SQLite facts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-a09-executable-api-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  let database;
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const collection = `${daemon.url}/automations?cwd=${encodeURIComponent(cwd)}`;
    const trigger = { type: "schedule", timezone: "UTC", schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" };
    database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    const counts = () => ({ definitions: database.prepare("SELECT COUNT(*) AS n FROM automation_definitions").get().n,
      threads: database.prepare("SELECT COUNT(*) AS n FROM ling_threads WHERE kind = 'automation'").get().n });
    const before = counts();
    const rejected = await requestJson(collection, { method: "POST", body: {
      kind: "daily_brief", title: "A09 no representable next slot", channelId: channel.id, status: "paused", trigger,
      rrule: "FREQ=MINUTELY;INTERVAL=9007199254740991",
    } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /recurrence|rrule/i);
    assert.deepEqual(counts(), before, "rejection must precede both thread and definition inserts");
    const created = await postJson(collection, { kind: "daily_brief", title: "A09 editable valid slot", channelId: channel.id,
      status: "paused", trigger, rrule: "FREQ=DAILY;INTERVAL=7" });
    const item = `${collection.replace("?", `/${encodeURIComponent(created.automation.id)}?`)}`;
    const snapshot = await getJson(item);
    const wrongDay = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][(new Date(created.automation.createdAt).getUTCDay() + 1) % 7];
    const badUpdate = await requestJson(item, { method: "PATCH", body: { title: "Must not persist", rrule: `FREQ=DAILY;INTERVAL=7;BYDAY=${wrongDay}` } });
    assert.equal(badUpdate.status, 400);
    assert.deepEqual(await getJson(item), snapshot);
    assert.equal(runner.runs.length, 0);
  } finally {
    database?.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("A09 HTTP draft RRULE survives confirmation and failed admission is rollback-safe", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-a09-draft-rule-api-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  let database;
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const drafts = `${daemon.url}/automation-drafts?cwd=${encodeURIComponent(cwd)}`;
    const partial = { kind: "daily_brief", title: "A09 draft rule", channelId: channel.id,
      trigger: { type: "schedule", timezone: "UTC", schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" },
      promptTemplate: { templateVersion: 1, promptMarkdown: "QA schedule only", contextSelectors: [] } };
    const rule = "FREQ=MINUTELY;INTERVAL=2";
    const created = await postJson(drafts, { source: "manual", partialAutomation: { ...partial, rrule: rule } });
    assert.equal(created.draft.rrule, rule);
    const item = `${daemon.url}/automation-drafts/${encodeURIComponent(created.draft.id)}?cwd=${encodeURIComponent(cwd)}`;
    assert.equal((await getJson(item)).draft.rrule, rule);
    assert.equal((await patchJson(item, { partialAutomation: { title: "A09 edited draft" } })).draft.rrule, rule);
    const confirmed = await postJson(item.replace("?", "/confirm?"), {});
    assert.equal(confirmed.automation.rrule, rule);
    const repeated = await postJson(item.replace("?", "/confirm?"), {});
    assert.equal(repeated.automation.id, confirmed.automation.id);
    const bad = await postJson(drafts, { source: "manual", partialAutomation: {
      ...partial, title: "A09 uncomputable draft", rrule: "FREQ=MINUTELY;INTERVAL=9007199254740991",
    } });
    database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    const counts = () => ({ definitions: database.prepare("SELECT COUNT(*) AS n FROM automation_definitions").get().n,
      threads: database.prepare("SELECT COUNT(*) AS n FROM ling_threads WHERE kind = 'automation'").get().n });
    const before = counts();
    const badItem = `${daemon.url}/automation-drafts/${encodeURIComponent(bad.draft.id)}?cwd=${encodeURIComponent(cwd)}`;
    const snapshot = await getJson(badItem);
    const rejected = await requestJson(badItem.replace("?", "/confirm?"), { method: "POST", body: {} });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /recurrence|rrule/i);
    assert.deepEqual(counts(), before);
    assert.deepEqual(await getJson(badItem), snapshot);
    assert.equal((await patchJson(badItem, { partialAutomation: { rrule: null } })).draft.rrule, undefined);
    const repaired = await postJson(badItem.replace("?", "/confirm?"), {});
    assert.ok(repaired.automation.id);
    assert.equal(runner.runs.length, 0);
  } finally {
    database?.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class RecordingRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      task: options.task,
      tools: options.tools,
      approvalProfile: options.approvalProfile,
      appendSystemPrompt: options.appendSystemPrompt ?? [],
    });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "Automation report" }],
    };
  }
}

async function startDaemonForTest(runner) {
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    channels: { terminalReports: false },
  }, { runner });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function createChannel(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Engineering",
    status: "active",
    boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls"],
    ...overrides,
  });
}

async function createStaticChatProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

function simulateLegacyChannelWithoutModel(cwd, channelId) {
  const store = createSqliteRunStore(cwd);
  try {
    store.updateChannel(channelId, { defaultProviderPresetId: null }, new Date().toISOString());
  } finally {
    store.close();
  }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function getText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.text();
}

async function postJson(url, body) {
  const preparedBody = await prepareChannelCreateBody(url, body);
  await ensureGitRepoForChannelPost(url, preparedBody);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preparedBody),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function waitForCondition(predicate, description, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(50);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
