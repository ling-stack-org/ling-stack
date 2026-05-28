import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
  defaultChannelRuntimePolicy,
} from "../dist/index.js";

test("sqlite channels persist default and edited runtime policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-runtime-"));
  const now = "2026-05-26T00:00:00.000Z";
  const updatedAt = "2026-05-26T00:01:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const created = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
      },
      now,
    );

    assert.equal(created.status, "active");
    assert.deepEqual(created.runtimePolicy, defaultChannelRuntimePolicy);

    const updated = store.updateChannel(
      created.id,
      {
        status: "paused",
        runtimePolicy: {
          executionMode: "parallel",
          maxConcurrentRuns: 3,
          writeLockScope: "workspace",
          allowReadOnlyParallel: false,
          queueOnConflict: false,
        },
      },
      updatedAt,
    );

    assert.ok(updated);
    assert.equal(updated.status, "paused");
    assert.deepEqual(updated.runtimePolicy, {
      executionMode: "parallel",
      maxConcurrentRuns: 3,
      writeLockScope: "workspace",
      allowReadOnlyParallel: false,
      queueOnConflict: false,
    });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel workspace assets persist messages, attachments, and link previews", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workspace-"));
  const now = "2026-05-28T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
        defaultTeammateId: "engineer",
      },
      now,
    );
    const message = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        authorId: "tian",
        body: "请 @Engineer 看一下需求",
        mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      },
      now,
    );
    const attachment = store.createChannelAttachment({
      channelId: channel.id,
      messageId: message.id,
      kind: "pdf",
      fileName: "brief.pdf",
      contentType: "application/pdf",
      sizeBytes: 128,
      path: `${channel.id}/brief.pdf`,
      createdAt: now,
    });
    const preview = store.createChannelLinkPreview(
      {
        channelId: channel.id,
        messageId: message.id,
        url: "https://example.com/#ignored",
        normalizedUrl: "https://example.com/",
        title: "Example",
        status: "ready",
      },
      now,
    );

    assert.equal(store.getChannel(channel.id).defaultTeammateId, "engineer");
    assert.deepEqual(store.listChannelMessages({ channelId: channel.id }).map((item) => item.id), [message.id]);
    assert.equal(store.getChannelMessage(message.id).mentions[0].id, "engineer");
    assert.deepEqual(store.listChannelAttachments({ channelId: channel.id }).map((item) => item.id), [attachment.id]);
    assert.equal(store.getChannelAttachment(attachment.id).fileName, "brief.pdf");
    assert.deepEqual(store.listChannelLinkPreviews({ channelId: channel.id }).map((item) => item.id), [preview.id]);

    const updatedPreview = store.updateChannelLinkPreview(
      preview.id,
      { status: "failed", errorMessage: "blocked", title: null },
      "2026-05-28T00:01:00.000Z",
    );
    assert.equal(updatedPreview.status, "failed");
    assert.equal(updatedPreview.title, undefined);
    assert.equal(updatedPreview.errorMessage, "blocked");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel collaboration protocol persists brief, decisions, handoffs, and summaries", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-"));
  const now = "2026-05-28T01:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const otherChannel = store.createChannel({ name: "Design", boundPath: cwd }, now);
    const message = store.createChannelMessage({ channelId: channel.id, authorType: "local-user", body: "Use manual handoffs." }, now);
    const otherMessage = store.createChannelMessage({ channelId: otherChannel.id, authorType: "local-user", body: "Wrong channel." }, now);
    const task = store.createTask({ channelId: channel.id, title: "Implement protocol", prompt: "Build v1.1." }, now);

    const firstDecision = store.createChannelDecision(
      {
        channelId: channel.id,
        sourceMessageId: message.id,
        title: "Manual handoffs",
        decision: "Handoffs are records only.",
        createdBy: "local-user",
      },
      now,
    );
    const secondDecision = store.createChannelDecision(
      {
        channelId: channel.id,
        title: "Manual handoffs update",
        decision: "Supersede without running agents.",
        supersedesDecisionId: firstDecision.id,
        createdBy: "local-user",
      },
      "2026-05-28T01:01:00.000Z",
    );
    assert.equal(store.getChannelDecision(firstDecision.id).status, "superseded");
    assert.equal(secondDecision.status, "active");

    const brief = store.updateChannelBrief(
      channel.id,
      {
        objective: "Ship channel v1.1",
        scope: "Track collaboration protocol.",
        acceptanceCriteria: ["Brief round trip"],
        decisionIds: [secondDecision.id],
        updatedBy: "local-user",
      },
      "2026-05-28T01:02:00.000Z",
    );
    assert.equal(store.getChannelBrief(channel.id).id, brief.id);
    assert.deepEqual(store.getChannelBrief(channel.id).decisionIds, [secondDecision.id]);

    const handoff = store.createChannelHandoff(
      {
        channelId: channel.id,
        sourceTaskId: task.id,
        fromParticipantId: "tian",
        fromParticipantLabel: "Tian",
        toParticipantId: "engineer",
        toParticipantLabel: "Engineer",
        reason: "Need implementation",
        requiredInput: "Plan",
        expectedOutput: "Patch",
        createdBy: "local-user",
      },
      "2026-05-28T01:03:00.000Z",
    );
    assert.equal(store.updateChannelHandoff(handoff.id, { status: "completed" }, "2026-05-28T01:04:00.000Z").status, "completed");
    assert.equal(store.getTask(task.id).status, "todo");

    const summary = store.createChannelContextSummary(
      {
        channelId: channel.id,
        targetType: "task",
        targetId: task.id,
        sourceMessageIds: [message.id],
        decisionIds: [secondDecision.id],
        summary: "Implement the protocol state without agent automation.",
        authorType: "local-user",
      },
      "2026-05-28T01:05:00.000Z",
    );
    assert.deepEqual(store.listChannelContextSummaries({ channelId: channel.id, targetType: "task", targetId: task.id }).map((item) => item.id), [summary.id]);
    assert.throws(
      () => store.createChannelContextSummary(
        {
          channelId: channel.id,
          targetType: "thread",
          targetId: otherMessage.id,
          sourceMessageIds: [otherMessage.id],
          summary: "Cross channel should fail.",
          authorType: "local-user",
        },
        now,
      ),
      /does not belong to channel|not found/,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite task CAS claim and idempotency allow only one real transition", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-task-cas-"));
  const now = "2026-05-26T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const task = store.createTask(
      {
        channelId: channel.id,
        title: "Inspect workspace",
        prompt: "Inspect the repo.",
      },
      now,
    );

    const first = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_first",
      idempotencyKey: "client-key-1",
      now: "2026-05-26T00:00:01.000Z",
    });
    assert.deepEqual(first, { ok: true, from: "todo", to: "claimed" });

    const stale = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_second",
      idempotencyKey: "client-key-2",
      now: "2026-05-26T00:00:02.000Z",
    });
    assert.deepEqual(stale, {
      ok: false,
      code: "stale_transition",
      currentStatus: "claimed",
    });

    const duplicate = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_first",
      idempotencyKey: "client-key-1",
      now: "2026-05-26T00:00:03.000Z",
    });
    assert.deepEqual(duplicate, {
      ok: true,
      from: "claimed",
      to: "claimed",
      duplicate: true,
    });

    const events = store.listStateTransitionEvents({ entityType: "task", entityId: task.id });
    assert.equal(events.length, 1);
    assert.equal(events[0].fromStatus, "todo");
    assert.equal(events[0].toStatus, "claimed");
    assert.equal(events[0].idempotencyKey, "client-key-1");
    assert.equal(store.findStateTransitionByIdempotency("task", task.id, "client-key-1")?.reason, "run:run_first");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite active resource lease index blocks conflicting writers until release", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-lease-conflict-"));
  const store = createSqliteRunStore(cwd);
  const acquiredAt = "2026-05-26T00:00:00.000Z";
  const expiresAt = "2026-05-26T01:00:00.000Z";
  try {
    const first = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_first",
      acquiredAt,
      expiresAt,
    });
    assert.ok(first);

    const second = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_second",
      acquiredAt,
      expiresAt,
    });
    assert.equal(second, undefined);
    assert.equal(store.getBlockingResourceLease("bound_path", cwd)?.ownerId, "run_first");

    assert.equal(store.releaseResourceLeasesForOwner("run", "run_first", "2026-05-26T00:05:00.000Z"), 1);
    const afterRelease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_second",
      acquiredAt: "2026-05-26T00:05:01.000Z",
      expiresAt,
    });
    assert.ok(afterRelease);
    assert.equal(store.listResourceLeases({ status: "active", resourceType: "bound_path" }).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite lease expiry marks active stale leases as expired", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-lease-expiry-"));
  const store = createSqliteRunStore(cwd);
  try {
    const lease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "channel",
      resourceKey: "channel_1",
      ownerType: "run",
      ownerId: "run_stale",
      acquiredAt: "2026-05-26T00:00:00.000Z",
      expiresAt: "2026-05-26T00:01:00.000Z",
    });
    assert.ok(lease);

    assert.equal(store.expireResourceLeases("2026-05-26T00:02:00.000Z"), 1);
    assert.equal(store.listResourceLeases({ status: "active" }).length, 0);
    const expired = store.listResourceLeases({ status: "expired" });
    assert.equal(expired.length, 1);
    assert.equal(expired[0].ownerId, "run_stale");
    assert.equal(expired[0].releasedAt, "2026-05-26T00:02:00.000Z");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel runtime migration self-heals missing lease tables", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-runtime-heal-"));
  let store = createSqliteRunStore(cwd);
  try {
    const databasePath = store.paths.databasePath;
    store.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec("DROP TABLE resource_leases;");
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_leases'").get()), false);
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    const lease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_healed",
      acquiredAt: "2026-05-26T00:20:00.000Z",
      expiresAt: "2026-05-26T00:30:00.000Z",
    });
    assert.ok(lease);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel workspace migration self-heals old channel and task columns", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workspace-heal-"));
  const now = "2026-05-28T00:10:00.000Z";
  const initialStore = createSqliteRunStore(cwd);
  try {
    const databasePath = initialStore.paths.databasePath;
    initialStore.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        ALTER TABLE channels DROP COLUMN default_teammate_id;
        ALTER TABLE tasks DROP COLUMN assignee_teammate_id;
        DROP TABLE channel_messages;
        DROP TABLE channel_attachments;
        DROP TABLE channel_link_previews;
      `);
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_messages'").get()), false);
    } finally {
      database.close();
    }

    const store = createSqliteRunStore(cwd);
    try {
      const channel = store.createChannel(
        {
          name: "Engineering",
          boundPath: cwd,
          defaultTeammateId: "engineer",
        },
        now,
      );
      const task = store.createTask(
        {
          channelId: channel.id,
          title: "Clarify channel requirements",
          prompt: "Turn the discussion into an executable task.",
          assigneeTeammateId: "engineer",
        },
        now,
      );
      const message = store.createChannelMessage(
        {
          channelId: channel.id,
          authorType: "local-user",
          body: "Migration should keep channel chat writable.",
        },
        now,
      );

      assert.equal(store.getChannel(channel.id).defaultTeammateId, "engineer");
      assert.equal(store.getTask(task.id).assigneeTeammateId, "engineer");
      assert.equal(store.getChannelMessage(message.id).body, "Migration should keep channel chat writable.");
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel protocol migration self-heals missing protocol tables", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-heal-"));
  const now = "2026-05-28T02:00:00.000Z";
  const initialStore = createSqliteRunStore(cwd);
  try {
    const databasePath = initialStore.paths.databasePath;
    initialStore.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP TABLE channel_briefs;
        DROP TABLE channel_decisions;
        DROP TABLE channel_handoffs;
        DROP TABLE channel_context_summaries;
      `);
      assert.equal(Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_briefs'").get()), false);
    } finally {
      database.close();
    }

    const store = createSqliteRunStore(cwd);
    try {
      const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
      const brief = store.updateChannelBrief(
        channel.id,
        {
          objective: "Self heal protocol tables",
          scope: "Ensure old DBs can write v1.1 state.",
          updatedBy: "local-user",
        },
        now,
      );
      assert.equal(brief.objective, "Self heal protocol tables");
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
