import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createBuiltinAiTeammateId,
  createSqliteRunStore,
} from "../dist/index.js";

test("sqlite seeds durable builtin AI teammates and migrates legacy template references", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammates-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-05-29T00:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  let closed = false;
  try {
    const teammates = store.listAiTeammates({ includeHidden: true, includeDisabled: true });
    const engineer = teammates.find((item) => item.id === engineerId);
    assert.ok(engineer);
    assert.equal(engineer.templateId, "engineer");
    assert.equal(engineer.pinned, true);
    assert.ok(store.listTeammateSkillBindings(engineerId).some((binding) => binding.skillId === "implement"));

    const channel = store.createChannel({ name: "Engineering", boundPath: cwd, defaultTeammateId: "engineer" }, now);
    const task = store.createTask({ channelId: channel.id, title: "Legacy teammate", prompt: "Migrate me.", assigneeTeammateId: "engineer" }, now);
    store.close();
    closed = true;

    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getChannel(channel.id).defaultTeammateId, engineerId);
      assert.equal(reopened.getTask(task.id).assigneeTeammateId, engineerId);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite persists AI teammate direct thread, messages, channel memberships, and memory scopes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammate-private-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-05-29T01:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const skillBindings = store.replaceTeammateSkillBindings(
      engineerId,
      [
        { skillId: "implement", source: "template", enabled: false },
        { skillId: "plan-eng-review", source: "user", enabled: true },
      ],
      now,
    );
    assert.deepEqual(skillBindings.map((item) => [item.skillId, item.source, item.enabled]), [
      ["implement", "template", false],
      ["plan-eng-review", "user", true],
    ]);

    const memberships = store.replaceTeammateChannelMemberships(
      engineerId,
      [{ channelId: channel.id, isDefault: true }],
      now,
    );
    assert.deepEqual(memberships.map((item) => [item.channelId, item.isDefault]), [[channel.id, true]]);
    assert.equal(store.getChannel(channel.id).defaultTeammateId, engineerId);

    const scopes = store.replaceTeammateMemoryScopes(
      engineerId,
      [
        { kind: "private-chat-summary", enabled: true },
        { kind: "channel-brief", channelId: channel.id, enabled: true },
      ],
      now,
    );
    assert.deepEqual(scopes.map((item) => item.kind), ["private-chat-summary", "channel-brief"]);

    const thread = store.getOrCreateTeammateDirectThread(engineerId, now);
    const userMessage = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId: engineerId,
        authorType: "local-user",
        authorId: "tian",
        body: "Review the private workspace plan.",
      },
      now,
    );
    const aiMessage = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId: engineerId,
        authorType: "ai-teammate",
        body: "Private workspace plan reviewed.",
        status: "ready",
      },
      "2026-05-29T01:01:00.000Z",
    );
    assert.deepEqual(store.listTeammateDirectMessages({ teammateId: engineerId }).map((item) => item.id), [userMessage.id, aiMessage.id]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
