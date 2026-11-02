import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { createSqliteWorkflowIsolationStore, workflowIsolationDigest,
  toRuntimeAttemptFence, type RunArtifact, type RunSession, type RunStore, type WorkflowIsolationStore, type WorkflowIsolationTerminalCaptureResult,
  type WorkflowIsolationWriter } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { safeWorkflowGitPath } from "../workspaces/workflow-git-repository.js";
import { buildWorkflowStepOutputPacket, readWorkflowStepContextPacketArtifact } from "./workflow-step-packets.js";
import { captureWorkflowBranchResult, inspectSealedWorkflowBranchResult, workflowGitPacketDigest, workflowGitPacketJson,
  workflowGitResultRef, type WorkflowBranchCaptureContext, type WorkflowBranchResult, type WorkflowBranchResultPacketV1,
  type WorkflowBranchTerminalEvidence, type WorkflowGitRefEffect, type WorkflowGitRefJournal } from "./workflow-branch-result.js";

type TerminalAuthority = Extract<WorkflowIsolationTerminalCaptureResult, { readonly status: "authorized" }>;
interface MutationEvidence {
  readonly path: string;
  readonly before?: string;
  readonly after: string;
  readonly artifactIds: readonly string[];
}

export class WorkflowIsolatedResultError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}

const requireResult: (condition: unknown, code: string) => asserts condition = (condition, code) => {
  if (!condition) throw new WorkflowIsolatedResultError(code);
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown): boolean => workflowGitPacketJson(a) === workflowGitPacketJson(b);
const accepted = <T>(result: { readonly value: T } | { readonly code: string }): T => {
  if ("value" in result) return result.value;
  throw new WorkflowIsolatedResultError(result.code);
};

/** Synchronous semantic completion gate. A Run success or an unconfirmed Git intent is insufficient. */
export function workflowIsolatedResultBlocker(store: RunStore, run: RunSession, now: string): string | undefined {
  const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  const pin = isRecord(run.requestSnapshot) ? run.requestSnapshot.workflowIsolationPlan : undefined;
  if (!pin && !step?.metadata?.isolationScopePlan) return undefined;
  try {
    requireResult(isRecord(pin) && typeof pin.planId === "string" && typeof pin.planDigest === "string"
      && same(pin, step?.metadata?.isolationScopePlan), "workflow_isolation.result_plan_changed");
    const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
    const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
    requireResult(attempt, "workflow_isolation.result_binding_missing");
    const fence = toRuntimeAttemptFence(attempt);
    const writer = { bindingId: workflowIsolationDigest({ runId: run.id, ...fence }, "wib_"), ...fence };
    const isolation = createSqliteWorkflowIsolationStore(store), binding = isolation.getExecutionBinding(writer.bindingId);
    requireResult(binding?.runId === run.id && binding.planId === pin.planId && binding.planDigest === pin.planDigest,
      "workflow_isolation.result_binding_changed");
    const authority = isolation.assertTerminalCapture({ writer, expectedRevision: binding.revision, now });
    if (authority.status !== "authorized") return authority.code;
    const intent = isolation.getTerminalResultIntent(binding.bindingId);
    requireResult(intent?.status === "confirmed" && intent.proofDigest === authority.proofDigest
      && intent.bindingRevision === binding.revision && same(intent.writer, writer), "workflow_isolation.result_ref_unconfirmed");
    const artifact = sealedArtifact(store, intent.packetArtifactId, run.id), packet = artifact.sealedPayload;
    requireResult(isRecord(packet) && packet.kind === "workflow_branch_result" && packet.schemaVersion === 1
      && workflowGitPacketDigest(packet) === intent.packetDigest && artifact.contentSha256 === intent.packetContentSha256
      && packet.resultRef === intent.ref && packet.commit === intent.commit && packet.tree === intent.tree
      && isRecord(packet.context) && isRecord(packet.context.lineage) && packet.context.lineage.bindingId === binding.bindingId
      && isRecord(packet.terminal) && packet.terminal.outcome === run.status, "workflow_isolation.result_packet_changed");
    return undefined;
  } catch (error) {
    return error instanceof WorkflowIsolatedResultError ? error.code : "workflow_isolation.result_evidence_unverified";
  }
}

/** Preserve diagnostics without skipping the existing workflow terminal callback on capture failure. */
export async function settleWorkflowIsolatedResult(input: Parameters<typeof captureWorkflowIsolatedResult>[0]): Promise<void> {
  try {
    const result = await captureWorkflowIsolatedResult(input);
    const isolation = input.isolation ?? createSqliteWorkflowIsolationStore(input.store);
    const binding = isolation.getExecutionBinding(input.writer.bindingId);
    const run = binding && input.store.getRun(binding.runId);
    const step = run?.workflowStepId ? input.store.getChannelWorkflowStep(run.workflowStepId) : undefined;
    if (binding && step?.status === "blocked" && step.blocker?.startsWith("workflow_isolation.result_")) {
      const now = input.now?.() ?? new Date().toISOString();
      accepted(isolation.resumeTerminalResultStep({ writer: input.writer, expectedBindingRevision: binding.revision,
        now }));
      projectResultOutput(input.store, binding, result.packet.terminal.outputPacketArtifactRef, now);
    }
  }
  catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code : "workflow_isolation.result_capture_unverified";
    try {
      const isolation = input.isolation ?? createSqliteWorkflowIsolationStore(input.store);
      const binding = isolation.getExecutionBinding(input.writer.bindingId);
      if (!binding) return;
      const payload = { schemaVersion: 1, kind: "workflow_isolation_result_capture_blocked", writer: input.writer, code };
      const now = input.now?.() ?? new Date().toISOString();
      try {
        ensureArtifact(input.store, workflowIsolationDigest(payload, "wirf_"), binding.runId,
          "Workflow isolated result capture blocked", payload, now);
      } finally {
        blockUnverifiedResultStep(input.store, binding.runId, binding.startOwner, code, now);
      }
    } catch {
      // Missing confirmed evidence still blocks semantic success; diagnostic IO must not strand the step running.
    }
  }
}

function blockUnverifiedResultStep(store: RunStore, runId: string, owner: TerminalAuthority["binding"]["startOwner"],
  code: string, now: string): void {
  const run = store.getRun(runId), step = run?.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  const workflow = step ? store.getChannelWorkflow(step.workflowId) : undefined;
  if (run?.status !== "succeeded" || !step || step.runId !== runId || !workflow
    || !["running", "waiting_for_approval"].includes(step.status)
    || !["running", "waiting_for_approval", "blocked"].includes(workflow.status)) return;
  const blocked = store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id,
    expectedStartOwner: owner, expectedStatus: step.status, taskId: run.taskId, runId,
    event: "blocked", actor: "system", reason: code, blocker: code, now });
  if (blocked.ok && ["running", "waiting_for_approval"].includes(workflow.status)) {
    store.transitionChannelWorkflowStatus({ workflowId: workflow.id, expectedStatus: workflow.status,
      event: "step_blocked", actor: "system", reason: code, now });
  }
}

/** Startup/tick recovery follows the original terminal lineage; it never redispatches a Runner. */
export async function reconcileWorkflowIsolatedResults(store: RunStore, workflowId: string,
  now: () => string = () => new Date().toISOString()): Promise<void> {
  for (const step of store.listChannelWorkflowSteps({ workflowId, complete: true })) {
    if (!step.metadata?.isolationScopePlan || !step.runId) continue;
    const run = store.getRun(step.runId);
    if (!run || !["succeeded", "failed"].includes(run.status)) continue;
    const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
    const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
    if (!attempt) continue;
    const fence = toRuntimeAttemptFence(attempt);
    const writer = { bindingId: workflowIsolationDigest({ runId: run.id, ...fence }, "wib_"), ...fence };
    await settleWorkflowIsolatedResult({ store, writer, now });
  }
}

/** Only the original drained terminal lineage may publish a result. This never authorizes a merge. */
export async function captureWorkflowIsolatedResult(input: {
  readonly store: RunStore;
  readonly writer: WorkflowIsolationWriter;
  readonly isolation?: WorkflowIsolationStore;
  readonly now?: () => string;
}): Promise<WorkflowBranchResult> {
  const { store, writer } = input, isolation = input.isolation ?? createSqliteWorkflowIsolationStore(store);
  const now = input.now ?? (() => new Date().toISOString());
  const binding = isolation.getExecutionBinding(writer.bindingId);
  requireResult(binding && same(binding.fence, fenceOf(writer)), "workflow_isolation.result_binding_changed");
  const readAuthority = (): TerminalAuthority => {
    const read = isolation.assertTerminalCapture({ writer, expectedRevision: binding.revision, now: now() });
    if (read.status !== "authorized") throw new WorkflowIsolatedResultError(read.code);
    return read;
  };
  const authority = readAuthority();
  const current = (): void => {
    requireResult(same(readAuthority(), authority), "workflow_isolation.result_terminal_changed");
  };
  const creation = binding.creationReceiptId ? isolation.getReceipt(binding.creationReceiptId) : undefined;
  const creationIntent = creation ? isolation.getIntent(creation.intentId) : undefined;
  const source = creation ? sealedArtifact(store, creation.artifactId, binding.runId).sealedPayload : undefined;
  requireResult(creation?.outcome === "confirmed" && creationIntent?.status === "confirmed"
    && creationIntent.kind === "worktree_create" && isRecord(source) && source.kind === "workflow_isolation_worktree"
    && source.schemaVersion === 1 && source.intentId === creationIntent.intentId && same(source.writer, writer)
    && source.planId === authority.plan.planId && source.planDigest === authority.plan.planDigest
    && same(source.observed, creation.observed) && isRecord(source.scope) && isRecord(source.scope.repository)
    && isRecord(source.receipt), "workflow_isolation.result_creation_changed");
  const { plan } = authority, scope = source.scope, receipt = source.receipt;
  requireResult(isRecord(scope.repository), "workflow_isolation.result_creation_changed");
  requireResult(scope.roundId === plan.integrationRoundId && scope.stepId === plan.workflowStepId
    && scope.generation === plan.stepGeneration && scope.worktreeId === plan.worktreeId
    && scope.executionRoot === plan.executionRoot && scope.branchRef === plan.branchRef && scope.baseCommit === plan.baseCommit
    && scope.repository.root === plan.canonicalWorkspaceRoot && scope.repository.commonDir === plan.repositoryIdentity.commonDir
    && receipt.executionRoot === plan.executionRoot && receipt.worktreeId === plan.worktreeId
    && receipt.branchRef === plan.branchRef && receipt.baseCommit === plan.baseCommit
    && receipt.commonDir === plan.repositoryIdentity.commonDir, "workflow_isolation.result_creation_changed");
  const mutations = mutationEvidence(store, authority);
  const linkedOwner = store.getChannelWorkflowStep(plan.workflowStepId)?.metadata?.startOwner;
  requireResult(linkedOwner?.phase === "linked", "workflow_isolation.result_lineage_missing");
  const context: WorkflowBranchCaptureContext = {
    scope: source.scope as unknown as WorkflowBranchCaptureContext["scope"],
    receipt: source.receipt as unknown as WorkflowBranchCaptureContext["receipt"],
    lineage: { workflowId: plan.workflowId, canonicalWorkspaceId: plan.canonicalWorkspaceId,
      canonicalWorkspaceRoot: plan.canonicalWorkspaceRoot, planId: plan.planId, planDigest: plan.planDigest,
      bindingId: binding.bindingId, bindingRevision: binding.revision, runId: binding.runId,
      startOwner: linkedOwner, ...binding.fence },
    allowedPaths: mutations.map(mutation => mutation.path).sort(),
  };
  const identity = workflowIsolationDigest({ bindingId: binding.bindingId, proofDigest: authority.proofDigest }, "wibr_");
  const terminal = terminalEvidence(store, authority, context, mutations, identity, now());
  const projectOutput = (result: WorkflowBranchResult): WorkflowBranchResult => {
    current();
    const step = store.getChannelWorkflowStep(plan.workflowStepId);
    requireResult(step?.runId === binding.runId, "workflow_isolation.result_lineage_missing");
    // Keep the result-gate audit version intact until Core resumes the original step.
    if (step.status !== "blocked" || !step.blocker?.startsWith("workflow_isolation.result_")) {
      projectResultOutput(store, binding, terminal.outputPacketArtifactRef, now());
    }
    current();
    return result;
  };
  const checkPacket = (effect: WorkflowGitRefEffect): WorkflowBranchResult => {
    current();
    let packet: WorkflowBranchResultPacketV1;
    try { packet = JSON.parse(effect.packetJson) as WorkflowBranchResultPacketV1; }
    catch (cause) { throw new WorkflowIsolatedResultError("workflow_isolation.result_packet_invalid", { cause }); }
    requireResult(effect.kind === "branch_capture" && effect.roundId === plan.integrationRoundId
      && effect.generation === plan.stepGeneration && effect.commonDir === plan.repositoryIdentity.commonDir
      && effect.beforeCommit === null && effect.ref === packet.resultRef && effect.afterCommit === packet.commit
      && effect.tree === packet.tree && effect.packetDigest === workflowGitPacketDigest(packet)
      && effect.packetJson === workflowGitPacketJson(packet) && same(packet.context, context) && same(packet.terminal, terminal),
    "workflow_isolation.result_packet_changed");
    verifyCapturedMutations(packet, mutations);
    return { status: "sealed", packet, packetDigest: effect.packetDigest, commit: effect.afterCommit,
      tree: effect.tree, resultRef: effect.ref };
  };
  const journal: WorkflowGitRefJournal = {
    recordIntent: async effect => {
      const result = checkPacket(effect);
      const packetArtifact = ensureArtifact(store, `${identity}_packet`, binding.runId, "Workflow isolated branch result", result.packet, now());
      const recorded = isolation.recordTerminalResultIntent({ intentId: `${identity}_intent`, writer,
        expectedBindingRevision: binding.revision, proofDigest: authority.proofDigest, packetArtifactId: packetArtifact.id,
        packetDigest: effect.packetDigest, ref: effect.ref, commit: effect.afterCommit, tree: effect.tree, now: now() });
      const intent = accepted(recorded);
      requireResult(recorded.status === "created", "workflow_isolation.result_intent_exists");
      return intent.intentId;
    },
    recordReceipt: async observation => {
      checkPacket(observation.effect);
      const intent = isolation.getTerminalResultIntent(binding.bindingId);
      requireResult(intent?.intentId === observation.intentId, "workflow_isolation.result_intent_changed");
      const payload = { schemaVersion: 1, kind: "workflow_isolation_result_ref_receipt", intentId: observation.intentId,
        effect: observation.effect,
        outcome: observation.outcome, observedCommit: observation.observedCommit };
      const artifact = ensureArtifact(store, workflowIsolationDigest(payload, "wirra_"), binding.runId,
        "Workflow isolated result ref observation", payload, now());
      accepted(isolation.recordTerminalResultReceipt({ receiptId: workflowIsolationDigest(payload, "wirr_"),
        intentId: intent.intentId, writer, expectedRevision: intent.revision, outcome: observation.outcome,
        observedCommit: observation.observedCommit, artifactId: artifact.id, now: now() }));
    },
  };
  const prior = isolation.getTerminalResultIntent(binding.bindingId);
  if (prior) {
    requireResult(prior.proofDigest === authority.proofDigest, "workflow_isolation.result_terminal_changed");
    const artifact = sealedArtifact(store, prior.packetArtifactId, binding.runId);
    const packet = artifact.sealedPayload as WorkflowBranchResultPacketV1;
    const effect: WorkflowGitRefEffect = { kind: "branch_capture", roundId: plan.integrationRoundId,
      generation: plan.stepGeneration, commonDir: plan.repositoryIdentity.commonDir, ref: prior.ref,
      beforeCommit: null, afterCommit: prior.commit, tree: prior.tree, packetDigest: prior.packetDigest,
      packetJson: workflowGitPacketJson(packet) };
    const result = checkPacket(effect);
    const observedCommit = await workflowGitResultRef(plan.canonicalWorkspaceRoot, prior.ref);
    current();
    // Recovery observes the original effect. It never recreates a missing ref or captures newer files.
    if (observedCommit !== prior.commit) {
      if (prior.status === "pending") await journal.recordReceipt({ intentId: prior.intentId, effect,
        outcome: observedCommit === null ? "blocked" : "effect_unknown", observedCommit });
      throw new WorkflowIsolatedResultError("workflow_isolation.result_ref_unconfirmed");
    }
    await inspectSealedWorkflowBranchResult(plan.canonicalWorkspaceRoot, result);
    current();
    if (prior.status !== "confirmed") await journal.recordReceipt({ intentId: prior.intentId, effect, outcome: "confirmed", observedCommit });
    requireResult(isolation.getTerminalResultIntent(binding.bindingId)?.status === "confirmed",
      "workflow_isolation.result_ref_unconfirmed");
    return projectOutput(result);
  }
  current();
  return projectOutput(await captureWorkflowBranchResult({ ...context, journal,
    assertTerminalQuiescent: () => { current(); return terminal; } }));
}

function projectResultOutput(store: RunStore, binding: TerminalAuthority["binding"], outputArtifactId: string, now: string): void {
  const run = store.getRun(binding.runId), step = run?.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  requireResult(step?.runId === binding.runId, "workflow_isolation.result_lineage_missing");
  if (step.metadata?.outputArtifactId === outputArtifactId) return;
  requireResult(store.updateChannelWorkflowStep(step.id, { expectedStartOwner: binding.startOwner,
    metadata: { ...step.metadata, outputArtifactId,
      outputArtifactIds: [...new Set([outputArtifactId, ...(step.metadata?.outputArtifactIds ?? []),
        ...store.listArtifacts(binding.runId).map(artifact => artifact.id)])] } }, now),
  "workflow_isolation.result_projection_changed");
}

function fenceOf(writer: WorkflowIsolationWriter) {
  return { workUnitId: writer.workUnitId, attemptId: writer.attemptId,
    runtimeInstanceId: writer.runtimeInstanceId, fencingToken: writer.fencingToken };
}

function sealedArtifact(store: RunStore, id: string, runId: string): RunArtifact {
  const artifact = store.getArtifact(id);
  requireResult(artifact?.runId === runId && artifact.sealedPayloadState !== "pruned" && isRecord(artifact.sealedPayload)
    && artifact.contentSha256 === sha256(JSON.stringify(artifact.sealedPayload)), "workflow_isolation.result_artifact_unverified");
  return artifact;
}

function ensureArtifact(store: RunStore, id: string, runId: string, title: string, payload: unknown, now: string): RunArtifact {
  const existing = store.getArtifact(id);
  if (existing) {
    const artifact = sealedArtifact(store, id, runId);
    requireResult(same(artifact.sealedPayload, payload), "workflow_isolation.result_artifact_changed");
    return artifact;
  }
  return store.createArtifact({ id, runId, title, type: "json", path: `sqlite:${id}`, contentType: "application/json",
    sealedPayload: payload, createdAt: now });
}

function mutationEvidence(store: RunStore, authority: TerminalAuthority): readonly MutationEvidence[] {
  const { binding, plan } = authority, mutations = new Map<string, MutationEvidence>();
  // This API returns the full inventory, not a first-page approximation.
  const completed = new Map<string, number>();
  let afterSeq = 0;
  while (true) {
    const events = store.listEvents(binding.runId, { afterSeq, limit: 1000 });
    for (const event of events) if (event.type === "tool_end" && isRecord(event.data)
      && event.data.attemptId === binding.fence.attemptId && typeof event.data.toolCallId === "string") {
      requireResult(!completed.has(event.data.toolCallId), "workflow_isolation.result_tool_unverified");
      completed.set(event.data.toolCallId, event.seq);
    }
    if (events.length < 1000) break;
    const latest = events.at(-1)!.seq;
    requireResult(latest > afterSeq, "workflow_isolation.result_tool_unverified");
    afterSeq = latest;
  }
  const tools = [...store.listHarnessToolExecutions(binding.runId)].sort((a, b) =>
    (completed.get(a.toolCallId) ?? 0) - (completed.get(b.toolCallId) ?? 0));
  for (const execution of tools) {
    requireResult(execution.attemptId === binding.fence.attemptId && execution.workUnitId === binding.fence.workUnitId
      && ["succeeded", "failed", "denied", "cancelled", "superseded"].includes(execution.state),
    "workflow_isolation.result_tool_unverified");
    if (execution.state !== "succeeded") continue;
    requireResult(completed.has(execution.toolCallId) && execution.executorKind === "write" && ["write", "edit"].includes(execution.toolName),
      "workflow_isolation.result_tool_unverified");
    const candidates = execution.evidenceArtifactIds.map(id => store.getArtifact(id))
      .filter(artifact => isRecord(artifact?.sealedPayload) && artifact.sealedPayload.kind === "workflow_isolation_file_mutation");
    requireResult(candidates.length === 1, "workflow_isolation.result_mutation_missing");
    const artifact = sealedArtifact(store, candidates[0]!.id, binding.runId), body = artifact.sealedPayload;
    requireResult(isRecord(body) && body.schemaVersion === 1 && body.bindingId === binding.bindingId
      && body.planId === plan.planId && body.planDigest === plan.planDigest && same(body.sourceFence, binding.fence)
      && body.creationReceiptId === binding.creationReceiptId && body.outcome === "applied" && body.status === "applied"
      && Array.isArray(body.touchedPaths) && body.touchedPaths.length === 1 && typeof body.touchedPaths[0] === "string"
      && isRecord(body.expectedMutation) && typeof body.expectedMutation.newSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(body.expectedMutation.newSha256)
      && (body.expectedMutation.oldSha256 === undefined || typeof body.expectedMutation.oldSha256 === "string"
        && /^[a-f0-9]{64}$/u.test(body.expectedMutation.oldSha256))
      && isRecord(body.executorResult) && body.executorResult.isError !== true && isRecord(body.executorResult.details)
      && body.executorResult.details.profile === "host_isolated_files_v1" && typeof body.executorResult.details.path === "string",
    "workflow_isolation.result_mutation_unverified");
    const path = relative(plan.executionRoot, resolve(plan.executionRoot, body.touchedPaths[0])).split(sep).join("/");
    requireResult(safeWorkflowGitPath(path) && path === body.executorResult.details.path
      && same(execution.resultSummary?.touchedPaths, body.touchedPaths) && execution.resultSummary?.outcome === "applied",
    "workflow_isolation.result_mutation_unverified");
    const prior = mutations.get(path), before = body.expectedMutation.oldSha256 as string | undefined;
    requireResult(!prior || prior.after === before, "workflow_isolation.result_mutation_chain_changed");
    mutations.set(path, { path, before: prior ? prior.before : before, after: body.expectedMutation.newSha256,
      artifactIds: [...(prior?.artifactIds ?? []), artifact.id] });
  }
  return [...mutations.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function verifyCapturedMutations(packet: WorkflowBranchResultPacketV1, mutations: readonly MutationEvidence[]): void {
  requireResult(Array.isArray(packet.changedPaths), "workflow_isolation.result_mutation_changed");
  const changed = new Map(packet.changedPaths.map(change => [change.path, change]));
  requireResult(changed.size === packet.changedPaths.length, "workflow_isolation.result_mutation_changed");
  for (const mutation of mutations) {
    const change = changed.get(mutation.path);
    if (!change) {
      requireResult(mutation.before === mutation.after, "workflow_isolation.result_mutation_changed");
      continue;
    }
    requireResult(change.after?.sha256 === mutation.after && change.before?.sha256 === mutation.before
      && change.change === (mutation.before === undefined ? "add" : "modify")
      && (!change.before || change.before.mode === change.after.mode), "workflow_isolation.result_mutation_changed");
    changed.delete(mutation.path);
  }
  requireResult(changed.size === 0, "workflow_isolation.result_mutation_changed");
}

function terminalEvidence(store: RunStore, authority: TerminalAuthority, context: WorkflowBranchCaptureContext,
  mutations: readonly MutationEvidence[], identity: string, now: string): WorkflowBranchTerminalEvidence {
  const { binding, plan, terminal, proofDigest } = authority;
  const run = store.getRun(binding.runId), workflow = store.getChannelWorkflow(plan.workflowId), step = store.getChannelWorkflowStep(plan.workflowStepId);
  requireResult(run && workflow && step, "workflow_isolation.result_lineage_missing");
  const base = { schemaVersion: 1, writer: { bindingId: binding.bindingId, ...binding.fence },
    planId: plan.planId, planDigest: plan.planDigest, proofDigest };
  const contextId = step.metadata?.contextArtifactId;
  const contextArtifact = contextId ? store.getArtifact(contextId) : undefined;
  const contextPacket = contextId ? readWorkflowStepContextPacketArtifact({ store, artifactId: contextId }) : undefined;
  requireResult(contextArtifact?.runId === run.id && contextPacket?.workflowId === workflow.id
    && contextPacket.workflowStepId === step.id && contextPacket.teammateId === step.toParticipantId,
  "workflow_isolation.result_context_missing");
  const contextSnapshot = ensureArtifact(store, `${identity}_context`, run.id, "Workflow isolated context snapshot",
    { ...base, kind: "workflow_isolation_context", sourceArtifactId: contextArtifact.id, packet: contextPacket }, now);
  const terminalArtifact = ensureArtifact(store, `${identity}_terminal`, run.id, "Workflow isolated terminal evidence",
    { ...base, kind: "workflow_isolation_terminal", outcome: terminal.outcome, endedAt: terminal.endedAt, audit: terminal.audit }, now);
  const quiescence = ensureArtifact(store, `${identity}_quiescence`, run.id, "Workflow isolated Host quiescence",
    { ...base, kind: "workflow_isolation_quiescence", completion: terminal.completion,
      descendantEvidenceFingerprint: terminal.descendantEvidenceFingerprint }, now);
  const tools = ensureArtifact(store, `${identity}_tools`, run.id, "Workflow isolated tool completion evidence",
    { ...base, kind: "workflow_isolation_tool_completion", effectDigest: terminal.effectDigest, mutations }, now);
  const outputId = `${identity}_output`, priorOutput = store.getArtifact(outputId);
  const output = priorOutput ? sealedArtifact(store, outputId, run.id) : ensureArtifact(store, outputId, run.id,
    "Workflow isolated step output", { ...buildWorkflowStepOutputPacket({ store, workflow,
      step: { ...step, status: terminal.outcome }, run, now: terminal.endedAt }), isolation: base }, now);
  const body = output.sealedPayload;
  requireResult(isRecord(body) && same(body.isolation, base) && body.workflowId === workflow.id
    && body.workflowStepId === step.id && body.runId === run.id && body.status === terminal.outcome,
  "workflow_isolation.result_output_changed");
  // Bounded file tools execute no validation commands. Do not manufacture a passing validation.
  return { lineage: context.lineage, outcome: terminal.outcome, terminalArtifactRef: terminalArtifact.id,
    quiescenceArtifactRef: quiescence.id, toolCompletionArtifactRef: tools.id, outputPacketArtifactRef: output.id,
    contextArtifactRefs: [contextSnapshot.id], validations: [], unknownEffects: [] };
}
