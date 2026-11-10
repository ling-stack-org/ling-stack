import { dirname, join } from "node:path";
import type { RunStore } from "../../run-types.js";
import type { WorkflowIntegrationCoordinatorStore } from "../../workflow-integration-coordinator-types.js";
import type { WorkflowIsolationStore, WorkflowIsolationMutationResult } from "../../workflow-isolation-types.js";
import type { WorkflowWorktreeCleanupStore, WorkflowWorktreeCleanupPlanV1, WorkflowWorktreeCleanupIntent,
  WorkflowWorktreeCleanupInspection, WorkflowWorktreeCleanupObservation, WorkflowWorktreeCleanupReceipt,
  WorkflowWorktreeCleanupRef } from "../../workflow-worktree-cleanup-types.js";
import { isWorkflowMergeTargetSnapshot, workflowMergeTargetSnapshotDigest } from "../../workflow-merge-approval.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest,
  workflowIsolationRecord as record, workflowIsolationIdentity as identity, workflowIsolationTime as time } from "../../workflow-isolation.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { harnessArtifactOwnerHolder, pinHarnessArtifactWithinTransaction, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";

type Rejection = { readonly status: "invalid" | "stale" | "conflict"; readonly code: string };
type RetainedArtifact = { readonly artifactId: string; readonly runId: string; readonly contentSha256: string };
class Rejected extends Error { constructor(readonly result: Rejection) { super(result.code); } }
function reject(status: Rejection["status"], code: string): never { throw new Rejected({ status, code: `workflow_cleanup.${code}` }); }
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
const scopeValid = (roundId: unknown, generation: unknown, worktreeId: unknown): boolean => identity(roundId)
  && Number.isSafeInteger(generation) && Number(generation) > 0 && identity(worktreeId);
const adapters = new WeakMap<RunStore, WorkflowWorktreeCleanupStore>();

export function createSqliteWorkflowWorktreeCleanupStore(store: RunStore): WorkflowWorktreeCleanupStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("workflow_cleanup.store_not_sqlite");
  return adapter;
}

/** Independent Host journal. No cleanup write can change delivery state, release resources or delete a ref. */
export function registerSqliteWorkflowWorktreeCleanupStore(store: RunStore, context: SqliteStoreContext,
  ports: Pick<RunStore, "getChannelWorkflow">, isolation: WorkflowIsolationStore,
  coordinator: WorkflowIntegrationCoordinatorStore): void {
  if (adapters.has(store)) throw new Error("workflow_cleanup.store_already_registered");
  adapters.set(store, new SqliteWorkflowWorktreeCleanupStore(context, ports, isolation, coordinator));
}

class SqliteWorkflowWorktreeCleanupStore implements WorkflowWorktreeCleanupStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Pick<RunStore, "getChannelWorkflow">,
    private readonly isolation: WorkflowIsolationStore, private readonly coordinator: WorkflowIntegrationCoordinatorStore) {}

  inspect(input: Parameters<WorkflowWorktreeCleanupStore["inspect"]>[0]): WorkflowWorktreeCleanupInspection {
    return readSqliteSnapshot(this.context.database, () => this.inspection(() => {
      if (this.intent(input.roundId, input.generation, input.worktreeId)) reject("conflict", "intent_already_exists");
      return this.plan(input);
    }));
  }

  begin(input: Parameters<WorkflowWorktreeCleanupStore["begin"]>[0]): WorkflowIsolationMutationResult<WorkflowWorktreeCleanupIntent> {
    return this.transaction(() => {
      if (!scopeValid(input.roundId, input.generation, input.worktreeId) || !identity(input.ownerToken)
        || !identity(input.planArtifactId) || !time(input.now)) reject("invalid", "intent_input_invalid");
      const existing = this.intent(input.roundId, input.generation, input.worktreeId);
      if (existing) return { status: "duplicate", value: existing }; // Observation only, including for the original owner.
      const plan = readSqliteWithinTransaction(this.context.database, () => this.plan(input));
      const artifact = this.artifact(input.planArtifactId, plan.runId);
      if (!same(artifact.body, plan)) reject("invalid", "plan_artifact_mismatch");
      if (this.context.database.prepare("SELECT 1 FROM workflow_worktree_cleanup_intents WHERE owner_token=?").get(input.ownerToken))
        reject("conflict", "owner_token_reused");
      const cleanupId = digest({ roundId: input.roundId, generation: input.generation, worktreeId: input.worktreeId }, "wwci_");
      const planDigest = digest(plan, "wwcp1_");
      const retained = [input.planArtifactId, ...plan.artifactIds].sort().map(artifactId => this.retained(artifactId));
      const intent: WorkflowWorktreeCleanupIntent = { cleanupId, roundId: input.roundId, generation: input.generation,
        worktreeId: input.worktreeId, ownerToken: input.ownerToken, planArtifactId: input.planArtifactId,
        planDigest, plan, createdAt: input.now };
      this.context.database.prepare(`INSERT INTO workflow_worktree_cleanup_intents(cleanup_id,round_id,generation,workflow_id,
        worktree_id,owner_token,plan_artifact_id,plan_content_sha256,plan_digest,retained_artifacts_json,intent_digest,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(cleanupId, input.roundId, input.generation, plan.workflowId, input.worktreeId,
          input.ownerToken, input.planArtifactId, artifact.contentSha256, planDigest, json(retained),
          digest({ ...intent, retained }), input.now);
      for (const retainedArtifact of retained) this.pin(retainedArtifact.artifactId, cleanupId, input.now);
      return { status: "created", value: this.intent(input.roundId, input.generation, input.worktreeId)! };
    });
  }

  getIntent(roundId: string, generation: number, worktreeId: string): WorkflowWorktreeCleanupIntent | undefined {
    return readSqliteSnapshot(this.context.database, () => this.intent(roundId, generation, worktreeId));
  }

  listIntents(input: Parameters<WorkflowWorktreeCleanupStore["listIntents"]>[0] = {}): readonly WorkflowWorktreeCleanupIntent[] {
    return readSqliteSnapshot(this.context.database, () => {
      if (input.roundId !== undefined && !identity(input.roundId) || input.workflowId !== undefined && !identity(input.workflowId)
        || input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 1))
        reject("invalid", "inventory_input_invalid");
      return this.context.database.prepare(`SELECT round_id,generation,worktree_id FROM workflow_worktree_cleanup_intents
        WHERE (? IS NULL OR round_id=?) AND (? IS NULL OR generation=?) AND (? IS NULL OR workflow_id=?)
        ORDER BY round_id,generation,worktree_id`).all(input.roundId ?? null, input.roundId ?? null,
          input.generation ?? null, input.generation ?? null, input.workflowId ?? null, input.workflowId ?? null)
        .map(row => this.intent(String(row.round_id), Number(row.generation), String(row.worktree_id))!);
    });
  }

  assertIntent(input: Parameters<WorkflowWorktreeCleanupStore["assertIntent"]>[0]): WorkflowWorktreeCleanupInspection {
    return readSqliteSnapshot(this.context.database, () => this.inspection(() => {
      if (!identity(input.ownerToken) || !time(input.now)) reject("invalid", "assertion_input_invalid");
      const intent = this.intentById(input.cleanupId);
      if (intent.ownerToken !== input.ownerToken) reject("stale", "intent_owner_changed");
      if (this.receipts(intent).length) reject("conflict", "intent_observed");
      const plan = this.plan({ ...intent, now: input.now });
      if (!same(plan, intent.plan)) reject("stale", "plan_changed");
      return plan;
    }));
  }

  recordObservation(input: Parameters<WorkflowWorktreeCleanupStore["recordObservation"]>[0]): WorkflowIsolationMutationResult<WorkflowWorktreeCleanupReceipt> {
    return this.transaction(() => {
      if (!time(input.now)) reject("invalid", "observation_time_invalid");
      const intent = this.intentById(input.cleanupId);
      if (input.now < intent.createdAt) reject("invalid", "observation_time_invalid");
      const artifact = this.artifact(input.artifactId, intent.plan.runId);
      const observation = this.observation(artifact.body, intent);
      const receiptId = digest({ cleanupId: intent.cleanupId, observation }, "wwcr_");
      const prior = this.receipts(intent);
      const duplicate = prior.find(receipt => receipt.receiptId === receiptId);
      if (duplicate) return { status: "duplicate", value: duplicate };
      if (observation.state === "present" && prior.some(receipt => receipt.state === "removed")) reject("conflict", "removed_tombstone");
      const receipt: WorkflowWorktreeCleanupReceipt = { receiptId, cleanupId: intent.cleanupId,
        state: observation.state, artifactId: input.artifactId, createdAt: input.now };
      this.context.database.prepare(`INSERT INTO workflow_worktree_cleanup_receipts(receipt_id,cleanup_id,state,artifact_id,
        artifact_content_sha256,receipt_digest,created_at) VALUES(?,?,?,?,?,?,?)`).run(receiptId, intent.cleanupId,
          receipt.state, receipt.artifactId, artifact.contentSha256, digest({ ...receipt, contentSha256: artifact.contentSha256 }), input.now);
      this.pin(input.artifactId, intent.cleanupId, input.now);
      return { status: "created", value: receipt };
    });
  }

  listReceipts(cleanupId: string): readonly WorkflowWorktreeCleanupReceipt[] {
    return readSqliteSnapshot(this.context.database, () => this.receipts(this.intentById(cleanupId)));
  }

  private plan(input: { readonly roundId: string; readonly generation: number; readonly worktreeId: string; readonly now: string }): WorkflowWorktreeCleanupPlanV1 {
    if (!scopeValid(input.roundId, input.generation, input.worktreeId) || !time(input.now)) reject("invalid", "scope_invalid");
    const authority = this.coordinator.assertAuthority(input);
    if (authority.status !== "authorized") throw new Rejected({ status: "stale", code: authority.code });
    const { round, participants } = authority, { inputs } = round;
    if (this.ports.getChannelWorkflow(inputs.workflowId)?.status !== "succeeded") reject("conflict", "workflow_not_succeeded");
    if (round.phase !== (inputs.mode === "candidate_only" ? "awaiting_approval" : "applied") || !round.candidate || round.openIntentId)
      reject("conflict", "delivery_unconfirmed");
    const blocker = this.coordinator.readPublicationBlocker(inputs.workflowId) ?? this.coordinator.readCompletionBlocker(inputs.workflowId);
    if (blocker) throw new Rejected({ status: "conflict", code: blocker });
    const role = input.worktreeId === inputs.integration.worktreeId ? "integration" : "step";
    const owner = participants.find(participant => role === "integration" ? participant.binding.bindingId === authority.writer.bindingId
      : participant.plan.worktreeId === input.worktreeId);
    if (!owner) reject("invalid", "worktree_not_owned");
    const artifactIds = new Set<string>();
    const remember = (id: unknown, runId: string) => {
      if (!identity(id)) reject("invalid", "artifact_identity_invalid");
      const artifact = this.artifact(id, runId);
      artifactIds.add(id);
      return artifact.body;
    };
    const refs = new Map<string, string>();
    const retainRef = (ref: unknown, commit: unknown) => {
      if (typeof ref !== "string" || !ref.startsWith("refs/ling/workflow/") || /[\x00-\x20\x7f]/u.test(ref)
        || typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)
        || commit.length !== inputs.baseCommit.length || refs.has(ref) && refs.get(ref) !== commit)
        reject("invalid", "retained_ref_invalid");
      refs.set(ref, commit);
    };
    for (const participant of participants) {
      const { binding, resultIntent } = participant;
      const creation = binding.creationReceiptId && this.isolation.getReceipt(binding.creationReceiptId);
      if (!creation || creation.outcome !== "confirmed") reject("invalid", "creation_receipt_unverified");
      remember(creation.artifactId, binding.runId);
      const packet = remember(resultIntent.packetArtifactId, binding.runId), terminal = packet.terminal;
      if (!record(terminal) || !Array.isArray(terminal.contextArtifactRefs) || !Array.isArray(terminal.validations))
        reject("invalid", "terminal_evidence_unverified");
      for (const id of [terminal.terminalArtifactRef, terminal.quiescenceArtifactRef,
        terminal.toolCompletionArtifactRef, terminal.outputPacketArtifactRef]) remember(id, binding.runId);
      for (const id of terminal.contextArtifactRefs) {
        const context = remember(id, binding.runId);
        // The sealed snapshot embeds the packet from the original file-backed context artifact.
        if (context.kind !== "workflow_isolation_context" || !identity(context.sourceArtifactId) || !record(context.packet))
          reject("invalid", "context_evidence_invalid");
      }
      for (const validation of terminal.validations) {
        if (!record(validation)) reject("invalid", "validation_evidence_invalid");
        remember(validation.artifactRef, binding.runId);
      }
      const tools = remember(terminal.toolCompletionArtifactRef, binding.runId);
      if (!Array.isArray(tools.mutations)) reject("invalid", "mutation_evidence_invalid");
      for (const mutation of tools.mutations) {
        if (!record(mutation) || !Array.isArray(mutation.artifactIds)) reject("invalid", "mutation_evidence_invalid");
        for (const id of mutation.artifactIds) remember(id, binding.runId);
      }
      for (const row of this.context.database.prepare("SELECT artifact_id FROM workflow_isolation_result_receipts WHERE intent_id=?").all(resultIntent.intentId))
        remember(row.artifact_id, binding.runId);
      retainRef(resultIntent.ref, resultIntent.commit);
    }
    const effects = this.coordinator.listEffects(input), receipts = this.coordinator.listReceipts(input);
    for (const effect of effects) {
      const binding = this.isolation.getExecutionBinding(effect.writer.bindingId);
      if (!binding) reject("invalid", "effect_writer_unverified");
      const body = remember(effect.payloadArtifactId, binding.runId);
      if (effect.effectKey.startsWith("ref:")) {
        if (!record(body.effect)) reject("invalid", "effect_evidence_invalid");
        retainRef(body.effect.ref, body.effect.afterCommit);
      }
    }
    for (const receipt of receipts) {
      const effect = effects.find(effect => effect.intentId === receipt.intentId)!;
      const binding = this.isolation.getExecutionBinding(effect.writer.bindingId)!;
      remember(receipt.artifactId, binding.runId);
    }
    let scope: unknown, creationReceipt: unknown;
    if (role === "integration") {
      const creation = effects.find(effect => effect.effectKey === "worktree:create");
      const confirmed = creation && receipts.find(receipt => receipt.intentId === creation.intentId && receipt.outcome === "confirmed");
      if (!creation || !confirmed) reject("invalid", "creation_receipt_unverified");
      const payload = remember(creation.payloadArtifactId, owner.binding.runId);
      const evidence = remember(confirmed.artifactId, owner.binding.runId).evidence;
      if (!record(payload.effect) || !record(evidence) || !same(evidence.scope, payload.effect.scope)) reject("invalid", "creation_evidence_changed");
      scope = evidence.scope;
      creationReceipt = evidence.receipt;
    } else {
      const creation = this.isolation.getReceipt(owner.binding.creationReceiptId!)!;
      const evidence = remember(creation.artifactId, owner.binding.runId);
      scope = evidence.scope;
      creationReceipt = evidence.receipt;
    }
    const location = role === "integration" ? inputs.integration : owner.binding.location;
    if (!record(scope) || !record(scope.repository) || !record(creationReceipt)
      || scope.roundId !== round.roundId || scope.stepId !== (role === "integration" ? "integration" : owner.plan.workflowStepId)
      || scope.generation !== (role === "integration" ? round.generation : owner.plan.stepGeneration)
      || scope.worktreeId !== location.worktreeId || scope.executionRoot !== location.executionRoot || scope.branchRef !== location.branchRef
      || scope.baseCommit !== inputs.baseCommit || scope.worktreeRoot !== dirname(location.executionRoot)
      || join(String(scope.worktreeRoot), location.worktreeId) !== location.executionRoot
      || typeof scope.repository.dirty !== "boolean" || !isWorkflowMergeTargetSnapshot({ ...scope.repository, dirty: false })
      || scope.repository.root !== inputs.canonicalWorkspaceRoot || scope.repository.commonDir !== inputs.repositoryIdentity.commonDir
      || workflowMergeTargetSnapshotDigest(scope.repository as unknown as WorkflowWorktreeCleanupPlanV1["scope"]["repository"]) !== inputs.target.cleanStateDigest
      || !same(creationReceipt, { ...location, baseCommit: inputs.baseCommit, commonDir: inputs.repositoryIdentity.commonDir,
        rootDevice: creationReceipt.rootDevice, rootInode: creationReceipt.rootInode })
      || ![creationReceipt.rootDevice, creationReceipt.rootInode].every(value => typeof value === "string" && /^[0-9]+$/u.test(value)))
      reject("invalid", "creation_evidence_changed");
    const retainedRefs: WorkflowWorktreeCleanupRef[] = [...refs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([ref, commit]) => ({ ref, commit }));
    if (!retainedRefs.length || retainedRefs.some(ref => ref.ref === location.branchRef)) reject("invalid", "retained_refs_missing");
    return { schemaVersion: 1, kind: "workflow_worktree_cleanup_plan", roundId: round.roundId, generation: round.generation,
      workflowId: inputs.workflowId, inputsDigest: round.inputsDigest, authorityDigest: authority.authorityDigest, role,
      bindingId: owner.binding.bindingId, runId: owner.binding.runId, scope: scope as unknown as WorkflowWorktreeCleanupPlanV1["scope"],
      creationReceipt: creationReceipt as unknown as WorkflowWorktreeCleanupPlanV1["creationReceipt"],
      retainedRefs, artifactIds: [...artifactIds].sort() };
  }

  /** Historical reads depend on their retained envelope, never mutable workflow pins or current authority. */
  private intent(roundId: string, generation: number, worktreeId: string): WorkflowWorktreeCleanupIntent | undefined {
    if (!scopeValid(roundId, generation, worktreeId)) reject("invalid", "scope_invalid");
    const row = this.context.database.prepare("SELECT * FROM workflow_worktree_cleanup_intents WHERE round_id=? AND generation=? AND worktree_id=?")
      .get(roundId, generation, worktreeId);
    if (!row) return undefined;
    const artifact = this.retained(String(row.plan_artifact_id)), body = this.artifact(artifact.artifactId, artifact.runId).body;
    if (body.schemaVersion !== 1 || body.kind !== "workflow_worktree_cleanup_plan" || body.roundId !== roundId
      || body.generation !== generation || body.workflowId !== row.workflow_id || body.runId !== artifact.runId
      || !record(body.scope) || body.scope.worktreeId !== worktreeId || !Array.isArray(body.artifactIds)
      || body.artifactIds.some(id => !identity(id)) || new Set(body.artifactIds).size !== body.artifactIds.length)
      reject("invalid", "intent_plan_corrupt");
    const intent: WorkflowWorktreeCleanupIntent = { cleanupId: String(row.cleanup_id), roundId, generation, worktreeId,
      ownerToken: String(row.owner_token), planArtifactId: artifact.artifactId, planDigest: String(row.plan_digest),
      plan: body as unknown as WorkflowWorktreeCleanupPlanV1, createdAt: String(row.created_at) };
    const retained: unknown = JSON.parse(String(row.retained_artifacts_json));
    const expected = [intent.planArtifactId, ...intent.plan.artifactIds].sort().map(id => this.retained(id));
    if (!identity(intent.ownerToken) || !time(intent.createdAt) || intent.cleanupId !== digest({ roundId, generation, worktreeId }, "wwci_")
      || row.plan_content_sha256 !== artifact.contentSha256 || intent.planDigest !== digest(body, "wwcp1_")
      || !same(retained, expected) || row.intent_digest !== digest({ ...intent, retained })) reject("invalid", "intent_evidence_corrupt");
    return intent;
  }

  private intentById(id: string): WorkflowWorktreeCleanupIntent {
    if (!identity(id)) reject("invalid", "intent_identity_invalid");
    const row = this.context.database.prepare("SELECT round_id,generation,worktree_id FROM workflow_worktree_cleanup_intents WHERE cleanup_id=?").get(id);
    const intent = row && this.intent(String(row.round_id), Number(row.generation), String(row.worktree_id));
    if (!intent) reject("invalid", "intent_missing");
    return intent;
  }

  private receipts(intent: WorkflowWorktreeCleanupIntent): WorkflowWorktreeCleanupReceipt[] {
    return this.context.database.prepare("SELECT * FROM workflow_worktree_cleanup_receipts WHERE cleanup_id=? ORDER BY created_at,rowid")
      .all(intent.cleanupId).map(row => {
        const artifact = this.artifact(String(row.artifact_id), intent.plan.runId), observation = this.observation(artifact.body, intent);
        const receipt: WorkflowWorktreeCleanupReceipt = { receiptId: String(row.receipt_id), cleanupId: intent.cleanupId,
          state: observation.state, artifactId: String(row.artifact_id), createdAt: String(row.created_at) };
        if (!time(receipt.createdAt) || receipt.createdAt < intent.createdAt || row.state !== receipt.state
          || receipt.receiptId !== digest({ cleanupId: intent.cleanupId, observation }, "wwcr_")
          || row.artifact_content_sha256 !== artifact.contentSha256
          || row.receipt_digest !== digest({ ...receipt, contentSha256: artifact.contentSha256 })) reject("invalid", "receipt_evidence_corrupt");
        return receipt;
      });
  }

  private observation(body: Record<string, unknown>, intent: WorkflowWorktreeCleanupIntent): WorkflowWorktreeCleanupObservation {
    const value = body.observation, { scope, retainedRefs } = intent.plan;
    if (!record(value) || !["removed", "present", "unknown"].includes(String(value.state))
      || value.code !== undefined && (!identity(value.code) || value.state === "removed")) reject("invalid", "observation_invalid");
    const observation: WorkflowWorktreeCleanupObservation = { state: value.state as WorkflowWorktreeCleanupObservation["state"],
      executionRoot: scope.executionRoot, worktreeId: scope.worktreeId, branchRef: scope.branchRef,
      commonDir: scope.repository.commonDir, retainedRefs, ...(value.code ? { code: value.code as string } : {}) };
    if (!same(body, { schemaVersion: 1, kind: "workflow_worktree_cleanup_observation", cleanupId: intent.cleanupId,
      planDigest: intent.planDigest, observation })) reject("invalid", "observation_artifact_mismatch");
    return observation;
  }

  private retained(artifactId: string): RetainedArtifact {
    if (!identity(artifactId)) reject("invalid", "artifact_identity_invalid");
    const retained = readHarnessRetainedBody(this.context.database, artifactId);
    const row = this.context.database.prepare("SELECT run_id FROM artifacts WHERE id=?").get(artifactId);
    if (!row || !identity(row.run_id)) reject("invalid", "artifact_lineage_invalid");
    return { artifactId, runId: row.run_id, contentSha256: retained.contentSha256 };
  }

  private artifact(id: string, runId: string) {
    const retained = this.retained(id);
    const row = this.context.database.prepare("SELECT type,sealed_payload_json FROM artifacts WHERE id=?").get(id)!;
    const body: unknown = JSON.parse(String(row.sealed_payload_json));
    if (retained.runId !== runId || row.type !== "json" || !record(body)) reject("invalid", "artifact_lineage_invalid");
    return { body, contentSha256: retained.contentSha256 };
  }
  private pin(artifactId: string, cleanupId: string, now: string): void {
    pinHarnessArtifactWithinTransaction(this.context.database, { artifactId,
      holder: harnessArtifactOwnerHolder("workflow_cleanup", cleanupId), reason: "audit_hold", now });
  }
  private inspection(read: () => WorkflowWorktreeCleanupPlanV1): WorkflowWorktreeCleanupInspection {
    try { return { status: "eligible", plan: read() }; }
    catch (error) { return { status: "retained", code: error instanceof Rejected ? error.result.code : "workflow_cleanup.evidence_unverified" }; }
  }
  private transaction<T>(write: () => WorkflowIsolationMutationResult<T>): WorkflowIsolationMutationResult<T> {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const value = write(); this.context.database.exec("COMMIT"); return value; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); if (error instanceof Rejected) return error.result; throw error; }
  }
}
