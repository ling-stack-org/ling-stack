import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createChannelWorkspaceSnapshot,
  createDirectWorkspaceSnapshot,
  createSqliteRunStore,
  type ChannelWorkspaceBinding,
  type CreateRunInput,
} from "../dist/index.js";
import { createSqliteRunStoreFixture } from "./support/sqlite-run-store-fixture.mjs";

const now = "2026-11-17T00:00:00.000Z";
const later = "2026-11-17T00:01:00.000Z";
const engineer = "teammate_builtin_engineer";
type OwnerKind = "channel" | "direct";

async function fixture(t: TestContext, kind: OwnerKind) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-workspace-admission-"));
  const store = createSqliteRunStoreFixture(cwd);
  const observer = createSqliteRunStore(cwd);
  t.after(async () => {
    observer.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const binding: ChannelWorkspaceBinding = {
    mode: "managed_worktree", status: "ready", worktreePath: join(cwd, "managed"),
    branchName: "ling/managed", baseBranch: "main", baseCommit: "a".repeat(40), updatedAt: now,
  };
  const channel = kind === "channel" ? store.createChannel({ name: "Managed", boundPath: cwd, workspaceBinding: binding }, now) : undefined;
  const direct = kind === "direct" ? store.getOrCreateTeammateDirectThread(engineer, now) : undefined;
  if (direct) store.updateTeammateDirectThreadWorkspace(direct.id, binding, now);
  const thread = store.createLingThread({
    kind: channel ? "channel_discussion" : "teammate_direct",
    channelId: channel?.id, teammateId: direct?.teammateId,
    title: "Managed execution", objective: "Use current workspace binding",
  }, now);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", title: "Run", userInstruction: "Read the workspace" }, now);
  const snapshot = channel ? createChannelWorkspaceSnapshot(channel, cwd)
    : createDirectWorkspaceSnapshot({ ...direct!, workspaceBinding: binding }, cwd);
  const requestSnapshot: Record<string, unknown> = {
    cwd: binding.worktreePath, workspaceCwd: cwd, executionCwd: binding.worktreePath,
    threadId: thread.id, teammateId: direct?.teammateId,
    task: { id: "task", channelId: channel?.id },
    ...(channel ? { channelWorkspaceBinding: snapshot } : { directWorkspaceBinding: binding, directWorkspaceSnapshot: snapshot }),
  };
  const input: CreateRunInput = {
    id: "managed-run", cwd: binding.worktreePath!, taskId: "task",
    channelId: channel?.id, teammateId: direct?.teammateId,
    threadId: thread.id, turnId: turn.id, providerName: "fixture", providerModel: "fixture",
    selectedSkillId: "fixture-skill", taskSnapshot: requestSnapshot.task,
    providerSnapshot: {}, requestSnapshot, createdAt: now,
  };
  const before = { thread: store.getLingThread(thread.id), turn: store.getLingTurn(turn.id) };
  return {
    cwd, store, observer, channel, direct, binding, input, requestSnapshot, snapshot,
    updateBinding(value: ChannelWorkspaceBinding | null) {
      if (channel) observer.updateChannel(channel.id, { workspaceBinding: value }, later);
      else observer.updateTeammateDirectThreadWorkspace(direct!.id, value, later);
    },
    absent() {
      assert.equal(store.getRun(input.id), undefined);
      assert.deepEqual(store.listLingTurnRuns(turn.id), []);
      assert.deepEqual(store.listSkillUsageEvents({ runId: input.id }), []);
      assert.deepEqual(store.getLingTurn(turn.id), before.turn);
      assert.deepEqual(store.getLingThread(thread.id), before.thread);
    },
  };
}

for (const kind of ["channel", "direct"] as const) {
  test(`${kind} admission rejects a prepared Run after cleanup has completed on another connection`, async t => {
    const f = await fixture(t, kind);
    let resume!: () => void;
    const prepared = new Promise<void>(resolve => { resume = resolve; });
    const delayed = prepared.then(() => f.store.createRun(f.input));
    f.updateBinding({ ...f.binding, status: "not_created", updatedAt: later });
    resume();
    await assert.rejects(delayed, /Managed workspace binding/);
    f.absent();
  });

  test(`${kind} admission accepts the same ready path and branch despite observation timestamps changing`, async t => {
    const f = await fixture(t, kind);
    f.updateBinding({ ...f.binding, checkedAt: later, updatedAt: later });
    const run = f.store.createRun(f.input);
    assert.equal(run.cwd, f.binding.worktreePath);
    assert.equal(f.observer.getRun(run.id)?.status, "queued");
  });

  test(`${kind} admission rejects changed or removed binding identities`, async t => {
    for (const [label, change] of [
      ["path", { worktreePath: join("/", "another-worktree") }],
      ["branch", { branchName: "ling/replacement" }],
      ["mode", { mode: "external_path", executionPath: join("/", "external") }],
      ["blocked", { status: "blocked" }],
    ] as const) {
      await t.test(label, async subtest => {
        const f = await fixture(subtest, kind);
        f.updateBinding({ ...f.binding, ...change, updatedAt: later });
        assert.throws(() => f.store.createRun(f.input), /Managed workspace binding/);
        f.absent();
      });
    }
    await t.test("removed", async subtest => {
      const f = await fixture(subtest, kind);
      f.updateBinding(null);
      assert.throws(() => f.store.createRun(f.input), /Managed workspace binding/);
      f.absent();
    });
  });

  test(`${kind} admission rejects cwd or request snapshot drift`, async t => {
    const f = await fixture(t, kind);
    assert.throws(() => f.store.createRun({ ...f.input, cwd: f.cwd }), /Managed workspace binding/);
    f.absent();
    const key = kind === "channel" ? "channelWorkspaceBinding" : "directWorkspaceSnapshot";
    for (const change of [{ status: "not_created" }, { branchName: "ling/stale" }, { executionCwd: f.cwd }, { worktreePath: f.cwd }]) {
      assert.throws(() => f.store.createRun({ ...f.input,
        requestSnapshot: { ...f.requestSnapshot, [key]: { ...f.snapshot, ...change } } }), /Managed workspace binding/);
      f.absent();
    }
  });

  test(`${kind} admission rejects a request attached to another owner`, async t => {
    const f = await fixture(t, kind);
    const changed = kind === "channel"
      ? { channelId: f.store.createChannel({ name: "Other", workspaceBinding: f.binding }, now).id }
      : { teammateId: "teammate_builtin_designer" };
    assert.throws(() => f.store.createRun({ ...f.input, ...changed }), /Managed workspace binding/);
    f.absent();
  });
}

test("local channel snapshots preserve independently isolated workflow execution cwd", async t => {
  const f = await fixture(t, "channel");
  f.updateBinding({ mode: "local", status: "ready", updatedAt: later });
  const channel = f.store.getChannel(f.channel!.id)!;
  const requestSnapshot = { ...f.requestSnapshot, channelWorkspaceBinding: createChannelWorkspaceSnapshot(channel, f.cwd) };
  const run = f.store.createRun({ ...f.input, cwd: join(f.cwd, "isolated-workflow"), requestSnapshot });
  assert.equal(run.cwd, join(f.cwd, "isolated-workflow"));
});
