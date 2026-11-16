import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { workflowIsolationCanonicalJson, workflowIsolationDigest, workflowIsolationScopePlanDigest } from "../../dist/index.js";
import { workflowIsolationFixture, baseCommit, nextCommit, nextTree } from "./workflow-isolation-fixture.mjs";

export const resultTables = ["workflow_isolation_result_intents", "workflow_isolation_result_receipts"];
export const packetJson = workflowIsolationCanonicalJson;
export const packetDigest = value => workflowIsolationDigest(value, "wgp1_");
export const now = () => new Date().toISOString();
const sha256 = value => createHash("sha256").update(value).digest("hex");

/** Actual Host completion, runtime audit, lifecycle and sealed artifacts, without performing Git I/O. */
export async function workflowIsolationResultsFixture(t, { outcome = "succeeded", terminal = true } = {}) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false });
  const repository = { root: f.cwd, commonDir: f.inputs.repositoryIdentity.commonDir, gitDir: f.inputs.repositoryIdentity.commonDir,
    head: baseCommit, branchRef: "refs/heads/main", configurationDigest: "6".repeat(64),
    rootDevice: "1", rootInode: "10", commonDevice: "1", commonInode: "11", dirty: false };
  f.inputs = { ...f.inputs, target: { ...f.inputs.target, cleanStateDigest: `wgr1_${sha256(JSON.stringify(repository))}` } };
  const worktreeId = basename(f.executionRoot);
  const branchRef = `refs/heads/ling/workflow/${f.roundId}/${f.plan.workflowStepId}/1-${worktreeId}`;
  const plan = { ...f.plan, target: f.inputs.target, worktreeId, branchRef };
  f.plan = { ...plan, planDigest: workflowIsolationScopePlanDigest(plan) };
  f.create(); f.persistPin();
  f.scope = { roundId: f.roundId, stepId: f.plan.workflowStepId, generation: f.plan.stepGeneration, worktreeId,
    executionRoot: f.executionRoot, branchRef, baseCommit, worktreeRoot: dirname(f.executionRoot), repository };
  f.worktreeReceipt = { worktreeId, executionRoot: f.executionRoot, branchRef, baseCommit,
    commonDir: repository.commonDir, rootDevice: "1", rootInode: "20" };
  f.prepare();
  assert.equal(f.isolation.bindExecution(f.bindInput).status, "created");
  f.link();
  const creation = f.intent();
  const artifact = f.store.createArtifact({ runId: f.prepared.run.id, type: "json", path: "sqlite:creation",
    sealedPayload: { schemaVersion: 1, kind: "workflow_isolation_worktree", intentId: creation.intentId,
      planId: f.plan.planId, planDigest: f.plan.planDigest, writer: f.writer, scope: f.scope,
      receipt: f.worktreeReceipt, observed: creation.after }, createdAt: f.at(8) });
  assert.equal(f.isolation.recordReceipt({ receiptId: "creation-receipt", intentId: creation.intentId,
    expectedRevision: f.binding().revision, writer: f.writer, outcome: "confirmed", observed: creation.after,
    artifactId: artifact.id, now: f.at(9) }).status, "created");
  assert.equal(f.isolation.markExecutionReady({ commandId: "ready", writer: f.writer, expectedRevision: f.binding().revision,
    creationReceiptId: "creation-receipt", now: f.at(10) }).status, "updated");
  assert.equal(f.isolation.sealPreparedExecution({ writer: f.writer, expectedRevision: f.binding().revision,
    runnerExecutionInput: f.executionPayload(), now: f.at(11) }).status, "updated");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
  const fence = f.prepared.fence, runId = f.prepared.run.id;
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
  assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "queued", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: f.generation.task.id, expectedStatus: "claimed", event: "start_run",
    actor: "system", currentRunId: runId, now: now() }).ok, true);
  const source = { runId, ...fence };
  const lifetime = Promise.resolve();
  await f.store.trackHostAttemptCompletion(source, lifetime, () => true);
  if (terminal) {
    const event = outcome === "succeeded" ? "runner_succeeded" : "runner_failed";
    assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "running", event, actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event, actor: "runner", endedAt: now(), now: now() }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: outcome, endedAt: now(), now: now() }));
    f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: outcome, transitionedAt: now() },
      type: outcome === "succeeded" ? "work_unit_succeeded" : "work_unit_failed", actor: "runner", data: { runId } });
  }
  f.readAuthority = () => f.isolation.assertTerminalCapture({ writer: f.writer, expectedRevision: f.binding().revision, now: now() });
  f.release = () => { f.store.releaseHostAttemptResources(source, now());
    assert.equal(f.store.releaseResourceLease(f.generation.owner.leaseId, "workflow_step", f.plan.workflowStepId, now()), 1); };
  f.sealed = (id, body, extra = {}) => f.store.createArtifact({ id, runId, type: "json", path: `sqlite:${id}`,
    sealedPayload: body, createdAt: now(), ...extra });
  f.authority = terminal ? f.readAuthority() : undefined;
  if (terminal) assert.equal(f.authority.status, "authorized", JSON.stringify(f.authority));
  f.makePacket = () => {
    const authority = f.readAuthority(); assert.equal(authority.status, "authorized", JSON.stringify(authority));
    const binding = f.binding();
    const base = { schemaVersion: 1, writer: f.writer, planId: f.plan.planId, planDigest: f.plan.planDigest, proofDigest: authority.proofDigest };
    const terminalRef = f.sealed("result-terminal", { ...base, kind: "workflow_isolation_terminal", outcome,
      endedAt: authority.terminal.endedAt, audit: authority.terminal.audit });
    const quiescence = f.sealed("result-quiescence", { ...base, kind: "workflow_isolation_quiescence",
      completion: authority.terminal.completion, descendantEvidenceFingerprint: authority.terminal.descendantEvidenceFingerprint });
    const tools = f.sealed("result-tools", { ...base, kind: "workflow_isolation_tool_completion", effectDigest: authority.terminal.effectDigest, mutations: [] });
    const output = f.sealed("result-output", { isolation: base, workflowId: f.plan.workflowId,
      workflowStepId: f.plan.workflowStepId, runId, status: outcome });
    const context = f.sealed("result-context", { ...base, kind: "workflow_isolation_context" });
    const lineage = { workflowId: f.plan.workflowId, canonicalWorkspaceId: f.plan.canonicalWorkspaceId,
      canonicalWorkspaceRoot: f.cwd, planId: f.plan.planId, planDigest: f.plan.planDigest, bindingId: binding.bindingId,
      bindingRevision: binding.revision, runId, startOwner: f.current(f.scopeIsolation).metadata.startOwner, ...binding.fence };
    return { schemaVersion: 1, kind: "workflow_branch_result", context: { scope: f.scope, receipt: f.worktreeReceipt, lineage, allowedPaths: [] },
      terminal: { lineage, outcome, terminalArtifactRef: terminalRef.id, quiescenceArtifactRef: quiescence.id,
        toolCompletionArtifactRef: tools.id, outputPacketArtifactRef: output.id, contextArtifactRefs: [context.id], validations: [], unknownEffects: [] },
      policy: { schemaVersion: 1, maxEntries: 10000, maxDepth: 32, maxFileBytes: 1024 * 1024, maxScannedBytes: 64 * 1024 * 1024,
        maxChangedBytes: 6 * 1024 * 1024, maxPatchBytes: 4 * 1024 * 1024 }, baseCommit, commit: nextCommit, tree: nextTree,
      resultRef: `refs/ling/workflow/results/${f.roundId}/${f.plan.workflowStepId}/1-${worktreeId}`,
      changedPaths: [], patch: "", patchDigest: sha256(""), discovery: { trackedPaths: 0, files: 0, directories: 0,
        newPaths: [], ignoredResidue: [], excludedPaths: [] } };
  };
  f.packet = terminal ? f.makePacket() : undefined;
  if (f.packet) f.packetArtifact = f.sealed("result-packet", f.packet);
  f.resultIntentInput = (overrides = {}) => ({ intentId: "result-intent", writer: f.writer, expectedBindingRevision: f.binding().revision,
    proofDigest: f.authority.proofDigest, packetArtifactId: f.packetArtifact.id, packetDigest: packetDigest(f.packet),
    ref: f.packet.resultRef, commit: f.packet.commit, tree: f.packet.tree, now: now(), ...overrides });
  f.resultIntent = (overrides = {}) => { const result = f.isolation.recordTerminalResultIntent(f.resultIntentInput(overrides));
    assert.equal(result.status, "created", JSON.stringify(result)); return result.value; };
  f.resultEffect = (intent = f.isolation.getTerminalResultIntent(f.writer.bindingId)) => ({ kind: "branch_capture", roundId: f.roundId,
    generation: f.plan.stepGeneration, commonDir: f.plan.repositoryIdentity.commonDir, ref: intent.ref, beforeCommit: null,
    afterCommit: intent.commit, tree: intent.tree, packetDigest: intent.packetDigest, packetJson: packetJson(f.packet) });
  let counter = 0;
  f.resultReceiptInput = (overrides = {}) => {
    const intent = f.isolation.getTerminalResultIntent(f.writer.bindingId);
    const { receiptId = `result-receipt-${++counter}`, outcome: resultOutcome = "confirmed", observedCommit = f.packet.commit,
      artifactId: requestedArtifact, evidence: extraEvidence = {}, ...rest } = overrides;
    const body = { schemaVersion: 1, kind: "workflow_isolation_result_ref_receipt", intentId: intent.intentId,
      effect: f.resultEffect(intent), outcome: resultOutcome, observedCommit, ...extraEvidence };
    const artifact = requestedArtifact ? f.store.getArtifact(requestedArtifact) : f.sealed(`${receiptId}-artifact`, body);
    return { receiptId, intentId: intent.intentId, writer: f.writer, expectedRevision: intent.revision,
      outcome: resultOutcome, observedCommit, artifactId: artifact.id, now: now(), ...rest };
  };
  f.resultReceipt = (overrides = {}) => { const result = f.isolation.recordTerminalResultReceipt(f.resultReceiptInput(overrides));
    assert.equal(result.status, "created", JSON.stringify(result)); return result.value; };
  f.snapshotResults = () => Object.fromEntries([...resultTables, "harness_artifact_pins", "harness_artifact_pin_events"].map(table => [table,
    f.peer.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  f.noResultWrites = action => { const before = f.snapshotResults(); const result = action(); assert.deepEqual(f.snapshotResults(), before); return result; };
  return f;
}
