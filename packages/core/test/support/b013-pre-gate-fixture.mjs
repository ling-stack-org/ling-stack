import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, resolveStoragePaths } from "../../dist/index.js";

export const b013ParticipantId = "teammate_builtin_engineer";

/** Declarative fixture data, not a replacement gate selector or admission implementation. */
export function b013Gate({ stage = "pre", mode = "standard", statuses } = {}) {
  return { stage, approvalProfile: { mode, risk: "medium", requiredForTools: ["read"] },
    title: "Review B013 before execution", reason: "B013 explicit pre-execution decision",
    ...(statuses === undefined ? {} : { requiredForStatuses: statuses }) };
}

/** Every Store path is explicit and confined to this test's mkdtemp-owned root. */
export async function b013OwnedStore(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b013-pre-gate-")));
  const cwd = join(root, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${root}/`));
  const store = createSqliteRunStore(cwd, paths);
  t.after(async () => {
    try { store.close(); }
    finally {
      assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b013-pre-gate-`));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const channel = store.createChannel({ name: "B013 admission", boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"] }, new Date().toISOString());
  return { root, cwd, paths, store, channel };
}

export function b013CreateStep(f, metadata = {}, status = "queued") {
  const now = new Date().toISOString();
  const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id,
    title: "B013 pre-gate admission", objective: "Read only owned evidence after approval",
    status: "ready", createdBy: "local-user" }, now);
  const step = f.store.createChannelWorkflowStep({ workflowId: workflow.id,
    title: "Inspect owned evidence", prompt: "Read evidence.txt", status,
    toParticipantId: b013ParticipantId, toParticipantLabel: "Engineer",
    metadata: { policy: { onRunFailed: "block_for_user", onRunCancelled: "block_for_user",
      onApprovalDenied: "block_for_user", retryable: true }, ...metadata } }, now);
  return { workflow, step };
}

/** Count persisted facts rather than interpreting a response or UI projection as execution. */
export function b013FactCounts(store) {
  return Object.fromEntries(["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions", "approval_requests"]
    .map(table => [table, Number(store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
}
