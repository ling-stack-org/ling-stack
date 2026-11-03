import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, createWorkflowPreGateExecutionPermit, resolveStoragePaths } from "../../dist/index.js";
import { b013CreateStep, b013Gate, b013ParticipantId } from "./b013-pre-gate-fixture.mjs";

const snapshotTables = ["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions", "work_units",
  "work_unit_attempts", "resource_leases", "approval_requests", "approval_checkpoints", "approval_postcommit_effects",
  "state_transition_events"];

/** Two real connections share one explicitly isolated SQLite path; no Runner or daemon recovery is started. */
export async function b013PermitFixture(t, metadata = { gates: [b013Gate()] }) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b013-permit-")));
  const cwd = join(root, "workspace"), opened = new Set(), epoch = Date.now();
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${root}/`));
  assert.ok(paths.artifactsDir.startsWith(`${root}/`));
  t.after(async () => {
    try { for (const store of opened) if (store.database.isOpen) store.close(); }
    finally {
      assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b013-permit-`));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const at = seconds => new Date(epoch + seconds * 1_000).toISOString();
  function open() {
    const store = createSqliteRunStore(cwd, paths);
    opened.add(store);
    assert.equal(typeof store.requestChannelWorkflowStepPreApproval, "function",
      "B013 requires a fresh Core build: a missing new port is setup failure, not business RED");
    assert.equal(typeof store.resolveChannelWorkflowStepPreApproval, "function",
      "B013 requires a fresh Core build: a missing new port is setup failure, not business RED");
    return store;
  }
  const f = { root, cwd, paths, at, store: open(), peer: open() };
  f.channel = f.store.createChannel({ name: "B013 permit lifecycle", boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"] }, at(0));
  Object.assign(f, b013CreateStep(f, metadata));
  f.current = (store = f.store) => store.getChannelWorkflowStep(f.step.id);
  f.expected = (step = f.current()) => ({ status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt });
  f.executionPermit = (overrides = {}, step = f.current()) => createWorkflowPreGateExecutionPermit({
    mode: "create_and_run_task",
    taskTitle: step.title,
    taskPrompt: step.prompt,
    providerPresetId: step.metadata?.providerBinding?.providerPresetId
      ?? step.metadata?.providerPresetId ?? f.channel.defaultProviderPresetId,
    runnerId: step.metadata?.requestedRunnerId,
    assigneeTeammateId: step.toParticipantId,
    skipProviderPreflight: false,
    ...overrides,
  });
  f.request = (store = f.store, overrides = {}) => store.requestChannelWorkflowStepPreApproval({
    workflowStepId: f.step.id, expected: f.expected(f.current(store)), executionPermit: f.executionPermit({}, f.current(store)), now: at(1), ...overrides });
  f.resolve = (approval, store = f.store, now = at(3)) => store.resolveChannelWorkflowStepPreApproval({
    workflowStepId: f.step.id, approvalId: approval.id, now });
  f.approve = (approval, store = f.peer, now = at(2)) => {
    const result = store.approveApprovalRequest(approval.id, { resolvedBy: "local-user", reason: "B013 explicit fixture decision" }, now);
    assert.equal(result?.status, "approved");
    return result;
  };
  f.approved = () => {
    const result = f.request(); assert.equal(result.status, "requested", JSON.stringify(result));
    f.approve(result.approval);
    assert.equal(f.resolve(result.approval).status, "approved");
    return result.approval;
  };
  f.lease = (store = f.store, now = at(4)) => {
    const lease = store.acquireResourceLease({ workspaceId: f.channel.workspaceId,
      resourceType: "workflow_step", resourceKey: f.step.id, ownerType: "workflow_step", ownerId: f.step.id,
      acquiredAt: now, expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString() });
    assert.ok(lease, "only the explicit execution attempt obtains this real current lease");
    return lease;
  };
  f.beginInput = (lease, store = f.store, now = at(5)) => {
    const executionPermit = f.executionPermit({}, f.current(store));
    return { workflowStepId: f.step.id, expected: f.expected(f.current(store)), leaseId: lease.id,
      executionPermit,
      task: { channelId: f.channel.id, assigneeTeammateId: executionPermit.assigneeTeammateId,
        title: executionPermit.taskTitle, prompt: executionPermit.taskPrompt }, now };
  };
  f.snapshot = (store = f.peer) => Object.fromEntries(snapshotTables.map(table =>
    [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  f.count = (table, store = f.peer) => Number(store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  f.noExecution = ({ tasks = 0, owners = 0, activeLeases = 0 } = {}) => {
    assert.equal(f.count("tasks"), tasks);
    for (const table of ["run_sessions", "work_units", "work_unit_attempts"]) assert.equal(f.count(table), 0, table);
    const actualOwners = f.peer.database.prepare("SELECT metadata_json FROM channel_workflow_steps").all()
      .filter(row => row.metadata_json && JSON.parse(row.metadata_json).startOwner).length;
    assert.equal(actualOwners, owners, "persisted startOwner count");
    assert.equal(Number(f.peer.database.prepare("SELECT COUNT(*) AS count FROM resource_leases WHERE status='active'").get().count), activeLeases);
  };
  f.reopen = which => {
    const previous = f[which];
    if (previous.database.isOpen) previous.close();
    opened.delete(previous);
    f[which] = open();
    return f[which];
  };
  f.mutateMetadata = transform => {
    const step = f.current(f.peer), metadata = structuredClone(step.metadata ?? {});
    transform(metadata);
    return f.peer.updateChannelWorkflowStep(step.id, { metadata }, at(7));
  };
  f.mutateApprovalPayload = (approval, transform) => {
    const row = f.peer.database.prepare("SELECT payload_json FROM approval_requests WHERE id=?").get(approval.id);
    const payload = JSON.parse(row.payload_json); transform(payload);
    f.peer.database.prepare("UPDATE approval_requests SET payload_json=? WHERE id=?").run(JSON.stringify(payload), approval.id);
  };
  return f;
}

export function assertRefused(result) {
  assert.ok(result && ["invalid", "stale", "blocked"].includes(result.status), JSON.stringify(result));
}

/** This assertion distinguishes caller-created execution lease from any forbidden Task/owner side effect. */
export function assertBeginRefusesWithoutWrites(f, { tasks = 0, owners = 0, now = f.at(20) } = {}) {
  const lease = f.lease(f.store, now);
  const input = f.beginInput(lease, f.store, new Date(Date.parse(now) + 1_000).toISOString()), before = f.snapshot();
  const result = f.store.beginChannelWorkflowStepStart(input);
  assertRefused(result);
  assert.deepEqual(f.snapshot(), before, "failed begin must not write Task, owner, consume marker or advance audit");
  f.noExecution({ tasks, owners, activeLeases: 1 });
  assert.equal(f.store.releaseResourceLease(lease.id, "workflow_step", f.step.id, new Date(Date.parse(now) + 2_000).toISOString()), 1);
  return result;
}
