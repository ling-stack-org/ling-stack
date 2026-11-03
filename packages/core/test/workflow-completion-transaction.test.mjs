import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-10-22T12:00:00.000Z";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-workflow-completion-transaction-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Completion transaction QA", boundPath: cwd }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Original title",
    objective: "Verify transaction ownership", status: "ready", createdBy: "test" }, now);
  return { store, channel, workflow, database: store.database };
}

test("workflow completion does not commit the caller's successful transaction", async t => {
  const f = await fixture(t);
  f.database.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(f.store.updateChannelWorkflow(f.workflow.id, { status: "succeeded" }, now).status, "succeeded");
  } finally { f.database.exec("ROLLBACK"); }
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "ready");
});

test("workflow write failure preserves the caller's unrelated writes and transaction", async t => {
  const f = await fixture(t);
  f.database.exec(`CREATE TEMP TRIGGER e6_workflow_write_failure BEFORE UPDATE ON channel_workflows
    BEGIN SELECT RAISE(ABORT,'e6_workflow_write_failure'); END`);
  f.database.exec("BEGIN IMMEDIATE");
  try {
    f.database.prepare("UPDATE channels SET name='caller-marker' WHERE id=?").run(f.channel.id);
    assert.throws(() => f.store.updateChannelWorkflow(f.workflow.id, { status: "succeeded" }, now), /e6_workflow_write_failure/);
    assert.equal(f.store.getChannel(f.channel.id).name, "caller-marker");
    assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "ready");
    f.database.exec("COMMIT");
  } catch (error) { f.database.exec("ROLLBACK"); throw error; }
  assert.equal(f.store.getChannel(f.channel.id).name, "caller-marker");
});
