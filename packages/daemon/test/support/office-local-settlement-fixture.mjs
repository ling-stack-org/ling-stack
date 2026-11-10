import assert from "node:assert/strict";
import fs, { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../../dist/runtime/attempt-host-operation-tracker.js";
import { prepareOfficeArtifact } from "../../dist/features/office-documents/office-artifact-preparation.js";
import { captureOfficeLocalSnapshot } from "../../dist/features/office-documents/office-local-snapshot.js";
import { officeLocalWriteState, prepareOfficeLocalWrite, reserveOfficeLocalWriter } from "../../dist/features/office-documents/office-local-authority.js";

export const officeSettlementNow = () => new Date().toISOString();
export const requiredOfficeSettlementInput = Object.freeze({ kind: "user_input_required", requestId: "office-drain", requestVersion: 1 });

/** Real migrated SQLite, captured Host source, real docx SDK bytes and original opaque pair tickets. */
export async function createOfficeSettlementFixture(t, options = {}) {
  const path = options.path ?? "result.docx";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-pair-settlement-")));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: officeSettlementNow() });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "office-original-runtime",
    runnerId: "pi", status: "started", now: officeSettlementNow() });
  const fence = toRuntimeAttemptFence(attempt);
  const thread = store.createLingThread({ kind: "conversation", title: "Office pair settlement", objective: "Original writer authority" }, officeSettlementNow());
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Write", userInstruction: "Write", idempotencyKey: "turn",
    payload: { body: "Write", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, officeSettlementNow());
  store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId, taskId: "task", providerName: "test",
    providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: officeSettlementNow() });
  store.linkRunToWorkUnit("run", unit.id, officeSettlementNow());
  store.markRunStarted("run", officeSettlementNow());
  const source = { runId: "run", ...fence }, tracker = new AttemptHostOperationTracker({ store, source });
  let initialBytes;
  if (options.overwrite) {
    const initial = await prepareOfficeArtifact("office_create_document", { path,
      blocks: [{ type: "paragraph", text: "Original real SDK document before overwrite" }] });
    initialBytes = Buffer.from(initial.bytes);
    fs.mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), initialBytes);
  } else if (options.existingDirectories) fs.mkdirSync(dirname(join(cwd, path)), { recursive: true });
  // Observe the actual issued durable tickets; persisted IDs never reconstruct capabilities.
  const durableTickets = new Map(), admit = store.admitHostOperation.bind(store);
  store.admitHostOperation = input => {
    const ticket = admit(input); durableTickets.set(ticket.operationId, ticket); return ticket;
  };
  let reservation;
  try { reservation = reserveOfficeLocalWriter(tracker, store, "office-call", cwd); }
  finally { store.admitHostOperation = admit; }
  const snapshot = captureOfficeLocalSnapshot(cwd, path, "docx", source);
  const artifact = await prepareOfficeArtifact("office_create_document", { path, overwrite: options.overwrite === true,
    blocks: [{ type: "paragraph", text: "Actual SDK bytes for atomic Office pair settlement" }] });
  const f = { cwd, path, store, unit, attempt, fence, source, tracker, reservation, snapshot, artifact, initialBytes, durableTickets };
  f.prepare = () => {
    f.plan = prepareOfficeLocalWrite(reservation, snapshot, artifact, "a".repeat(64), "b".repeat(64));
    f.state = officeLocalWriteState(f.plan);
    f.prepared = store.getHostOfficeLocalExecution(f.plan.executionId);
    f.temporary = f.prepared.members.find(member => member.role === "temporary").path;
    return f.plan;
  };
  f.replaceOwner = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "office-successor-runtime", runnerId: "pi", status: "started", now: officeSettlementNow() });
  if (options.prepare !== false) f.prepare();
  return f;
}

/** Patch the actual Node native binding, preserving the fixed writer and real native calls. */
export function patchOfficeSettlementFs(t, name, replacement) {
  const original = fs[name];
  fs[name] = replacement(original); syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true; fs[name] = original; syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}

export function readOfficePairRows(f, store = f.store) {
  return store.database.prepare("SELECT * FROM host_operations WHERE operation_id IN (?,?) ORDER BY operation_id")
    .all(f.state.parent.operationId, f.state.producer.operationId);
}

export function assertOfficePairSafe(f, pair, store = f.store) {
  for (const [role, kind, evidenceKind] of [
    ["parent", "office_local_chain_completed", "office_local_chain_execution"],
    ["producer", "office_local_binary_completed", "office_local_binary_execution"],
  ]) {
    const row = pair[role];
    assert.equal(row.operationId, f.state[role].operationId);
    assert.equal(row.phase, "safe"); assert.equal(row.settlementKind, kind);
    assert.deepEqual(row.source, f.source);
    assert.deepEqual(row.evidenceRef, { kind: evidenceKind, id: f.plan.executionId });
    assert.match(row.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(store.getHostOperation(row.operationId), row, "safe getters must independently reverify the original receipt");
  }
  assert.equal(pair.parent.settledAt, pair.producer.settledAt);
  assert.notEqual(pair.parent.evidenceDigest, pair.producer.evidenceDigest, "chain and binary receipts cannot collapse into one scope");
  assert.deepEqual(store.listHostOperationBlockers(f.source), []);
}
