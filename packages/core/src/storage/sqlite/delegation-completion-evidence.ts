import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { DelegationMessageV1 } from "@ling-stack/contracts";
import {
  delegationCompletionEvidenceFingerprintV1, delegationCompletionRequiredStatusV1, delegationResultEvidenceRefsV1,
  type DelegationCompletionAttemptReadV1, type DelegationCompletionEvidenceV1, type DelegationCompletionIssueCodeV1,
  type DelegationCompletionIssueV1, type DelegationCompletionResultReadV1, type DelegationCompletionRootReadV1,
  type DelegationCompletionRunReadV1, type DelegationCompletionStepReadV1, type DelegationCompletionWorkUnitReadV1,
  type DelegationResultEvidenceRefV1, type DelegationResultV1, type GetDelegationCompletionEvidenceInput,
} from "../../delegation-completion-evidence.js";
import type { DelegationBudgetCharge, DelegationBudgetReservation } from "../../harness/delegation-write-types.js";
import { delegationDigest, delegationFence, delegationId, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { RunArtifact, RunSession, RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type WorkUnit, type WorkUnitAttempt } from "../../runtime-supervisor-types.js";
import { mapDelegationBudgetCharge, mapDelegationBudgetReservation, mapDelegationRootBudget } from "./delegation-budget-rows.js";
import { delegationMessageSelectSql, delegationStepSelectSql, mapDelegationMessage, mapDelegationStep } from "./delegation-mappers.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";

type Row = Record<string, SQLOutputValue>;
type Ports = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getHostAttemptCompletion" | "getArtifact">;
const MAX_STEPS = 4096, MAX_CHARGES = 16_384, MAX_RESULT_BYTES = 262_144;
const member = "IN (SELECT value FROM json_each(?))";

/**
 * Reads original SQLite facts in one read window. SAVEPOINT composes with both
 * an independent reader and the completion/publication writer's BEGIN IMMEDIATE;
 * releasing it never commits or rolls back that outer transaction.
 */
export class SqliteDelegationCompletionEvidenceStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  getDelegationCompletionEvidence(input: GetDelegationCompletionEvidenceInput): DelegationCompletionEvidenceV1 {
    if (!Array.isArray(input.rootRunIds) || input.rootRunIds.length > 1024) throw new Error("delegation.completion_invalid_input");
    const rootRunIds = [...new Set(input.rootRunIds.map(id => delegationId(id)))].sort();
    const db = this.context.database;
    db.exec("SAVEPOINT delegation_completion_read");
    try {
      const result = readSqliteWithinTransaction(db, () => this.read(rootRunIds));
      db.exec("RELEASE delegation_completion_read");
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO delegation_completion_read");
      db.exec("RELEASE delegation_completion_read");
      throw error;
    }
  }

  private read(rootRunIds: readonly string[]): DelegationCompletionEvidenceV1 {
    const db = this.context.database, at = new Date().toISOString();
    const issues: DelegationCompletionIssueV1[] = [];
    const issue = (code: DelegationCompletionIssueCodeV1, stepId?: string, runId?: string, fact?: unknown): void => {
      issues.push({ code, ...(stepId ? { stepId } : {}), ...(runId ? { runId } : {}),
        ...(fact === undefined ? {} : { factFingerprint: fingerprint(fact) }) });
    };
    const bounded = <T>(rows: readonly T[], limit: number): readonly T[] => {
      if (rows.length > limit) issue("delegation.completion_limit_exceeded");
      return rows.slice(0, limit);
    };
    const mapped = <T>(rows: readonly Row[], map: (row: Row) => T): T[] => rows.flatMap(row => {
      try { return [map(row)]; }
      catch { issue("delegation.completion_fact_invalid", undefined, undefined, row); return []; }
    });
    // UNION deduplicates even corrupt parent cycles. The recursive LIMIT bounds
    // work before sorting, rather than materializing an unbounded subtree.
    const runRows = bounded(db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT value FROM json_each(?) UNION
      SELECT child.id FROM run_sessions child JOIN tree parent ON child.parent_run_id=parent.id LIMIT ${MAX_STEPS + 1}
    ) SELECT id FROM tree ORDER BY id`).all(JSON.stringify(rootRunIds)), MAX_STEPS);
    const runIds = runRows.map(row => String(row.id)), runJson = JSON.stringify(runIds);
    const seedIds = new Set(rootRunIds), descendantJson = JSON.stringify(runIds.filter(id => !seedIds.has(id)));
    const seedsJson = JSON.stringify(rootRunIds);
    const stepRows = bounded(db.prepare(delegationStepSelectSql(`WHERE root_run_id ${member}
      OR parent_run_id ${member} OR child_run_id ${member}
      OR id IN (SELECT delegation_step_id FROM delegation_budget_reservations WHERE child_run_id ${member})
      ORDER BY id LIMIT ${MAX_STEPS + 1}`)).all(runJson, runJson, descendantJson, descendantJson), MAX_STEPS);
    const steps = mapped(stepRows, mapDelegationStep), stepIds = new Set(steps.map(step => step.id));
    const budgetRootIds = [...new Set([...rootRunIds, ...steps.map(step => step.rootRunId)])].sort();
    const rootsJson = JSON.stringify(budgetRootIds), stepJson = JSON.stringify([...stepIds]);
    const reservations = mapped(bounded(db.prepare(`SELECT * FROM delegation_budget_reservations
      WHERE root_run_id ${member} OR delegation_step_id ${member} OR child_run_id ${member}
      ORDER BY id LIMIT ${MAX_STEPS + 1}`).all(seedsJson, stepJson, descendantJson), MAX_STEPS), mapDelegationBudgetReservation);
    const reservationJson = JSON.stringify(reservations.map(reservation => reservation.id));
    const charges = mapped(bounded(db.prepare(`SELECT * FROM delegation_budget_charges
      WHERE reservation_id ${member} OR run_id ${member}
        OR (reservation_id IS NULL AND root_run_id ${member}) ORDER BY id LIMIT ${MAX_CHARGES + 1}`)
      .all(reservationJson, descendantJson, seedsJson), MAX_CHARGES), mapDelegationBudgetCharge);
    const budgets = mapped(db.prepare(`SELECT * FROM delegation_root_budgets WHERE root_run_id ${member} ORDER BY root_run_id`)
      .all(rootsJson), mapDelegationRootBudget);
    const resultMessages = mapped(bounded(db.prepare(delegationMessageSelectSql(`WHERE delegation_step_id ${member}
      AND kind='result' ORDER BY id LIMIT ${MAX_STEPS + 1}`)).all(stepJson), MAX_STEPS), mapDelegationMessage);
    const reservationByStep = new Map(reservations.map(reservation => [reservation.delegationStepId, reservation]));
    const reservationById = new Map(reservations.map(reservation => [reservation.id, reservation]));
    const stepById = new Map(steps.map(step => [step.id, step]));
    const budgetByRoot = new Map(budgets.map(budget => [budget.rootRunId, budget]));
    const rootsWithSteps = new Set(steps.map(step => step.rootRunId));
    const chargesByRun = groupBy(charges, charge => charge.runId);
    const chargesByReservation = groupBy(charges, charge => charge.reservationId);
    const rootChargesByRun = groupBy(charges, charge => charge.reservationId === undefined ? charge.runId : undefined);
    const chargeOrder = new Map(charges.map((charge, index) => [charge, index]));
    const resultsByStep = groupBy(resultMessages, message => message.delegationStepId);
    const runById = new Map<string, RunSession | undefined>();
    const run = (id: string): RunSession | undefined => {
      if (!runById.has(id)) runById.set(id, this.ports.getRun(id));
      return runById.get(id);
    };
    for (const reservation of reservations) if (!stepIds.has(reservation.delegationStepId)) {
      issue("delegation.completion_lineage_invalid", reservation.delegationStepId, reservation.childRunId, reservation);
    }
    for (const row of db.prepare(`SELECT r.id,u.owner_id FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id
      WHERE r.id ${member} AND u.owner_type='delegation_step' ORDER BY r.id`).all(descendantJson)) {
      if (typeof row.owner_id !== "string" || !stepIds.has(row.owner_id)) issue("delegation.completion_lineage_invalid", undefined, String(row.id), row);
    }
    const roots: DelegationCompletionRootReadV1[] = budgetRootIds.map(runId => {
      const root = run(runId), budget = budgetByRoot.get(runId);
      const ownCharges = rootChargesByRun.get(runId) ?? [];
      if (!root || budget && root.parentRunId !== undefined) issue("delegation.completion_lineage_invalid", undefined, runId);
      if (rootsWithSteps.has(runId) && !budget) issue("delegation.completion_budget_missing", undefined, runId);
      if (budget) {
        this.checkSealedArtifact(budget.authorityArtifactId, runId, budget.authorityDigest, issue);
        if (budget.priceArtifactId) this.checkSealedArtifact(budget.priceArtifactId, runId, budget.priceDigest!, issue);
      }
      return { runId, ...(root ? { run: runRead(root) } : {}), ...(budget ? { budget } : {}), charges: ownCharges };
    });
    const rootByRun = new Map(roots.map(root => [root.runId, root]));
    const reads: DelegationCompletionStepReadV1[] = steps.map(step => {
      const reservation = reservationByStep.get(step.id), parent = run(step.parentRunId);
      const child = reservation ? run(reservation.childRunId) : step.childRunId ? run(step.childRunId) : undefined;
      const unit = child?.workUnitId ? this.ports.getWorkUnit(child.workUnitId) : undefined;
      const attempt = unit?.activeAttemptId ? this.ports.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
      const parentAttempt = this.ports.getWorkUnitAttempt(step.parentAttemptId);
      // Keep the original OR attribution, including corrupt run/reservation
      // disagreements. Merge by original SQL position so each fact appears once
      // in exactly the same canonical order, without rescanning all charges.
      const ownCharges = mergeCharges(child ? chargesByRun.get(child.id) ?? [] : [],
        reservation ? chargesByReservation.get(reservation.id) ?? [] : [], chargeOrder);
      const completion = child && attempt ? this.ports.getHostAttemptCompletion({ runId: child.id, ...toRuntimeAttemptFence(attempt) }) : undefined;
      let quiescence: DelegationCompletionStepReadV1["quiescence"] = "not_evaluated";
      if (child && attempt && ["succeeded", "failed", "cancelled"].includes(child.status)) {
        try { assertUserInputDurableQuiescence(db, child.id, toRuntimeAttemptFence(attempt), Date.parse(at), "exact_attempt"); quiescence = "verified"; }
        catch { quiescence = "blocked"; }
      }
      const results = (resultsByStep.get(step.id) ?? []).map(message => this.resultRead(message, issue));
      const parentStepRow = step.parentDelegationStepId && !stepById.has(step.parentDelegationStepId)
        ? db.prepare(delegationStepSelectSql("WHERE id=?")).get(step.parentDelegationStepId) : undefined;
      const parentStep = step.parentDelegationStepId ? stepById.get(step.parentDelegationStepId)
        ?? (parentStepRow ? mapped([parentStepRow], mapDelegationStep)[0] : undefined) : undefined;
      const parentReservationRow = parentStep && !reservationByStep.has(parentStep.id)
        ? db.prepare("SELECT * FROM delegation_budget_reservations WHERE delegation_step_id=?").get(parentStep.id) : undefined;
      const parentReservation = parentStep ? reservationByStep.get(parentStep.id)
        ?? (parentReservationRow ? mapped([parentReservationRow], mapDelegationBudgetReservation)[0] : undefined) : undefined;
      const read: DelegationCompletionStepReadV1 = { step, ...(reservation ? { reservation } : {}),
        ...(parentStep ? { parentDelegationStep: parentStep } : {}), ...(parentReservation ? { parentReservation } : {}),
        ...(parent ? { parentRun: runRead(parent) } : {}), ...(parentAttempt ? { parentAttempt: attemptRead(parentAttempt) } : {}),
        ...(child ? { childRun: runRead(child) } : {}), ...(unit ? { workUnit: unitRead(unit) } : {}),
        ...(attempt ? { attempt: attemptRead(attempt) } : {}), ...(completion ? { hostCompletion: completion } : {}), quiescence,
        charges: ownCharges, results };
      const root = rootByRun.get(step.rootRunId);
      const parentUnit = parent?.workUnitId ? this.ports.getWorkUnit(parent.workUnitId) : undefined;
      const invalidLineage = !reservation || !parent || !child || !unit || !parentUnit || !parentAttempt || !root?.run || !root.budget
        || reservation.rootRunId !== step.rootRunId || step.childRunId !== undefined && step.childRunId !== child.id
        || reservation.childRunId !== child.id || child.parentRunId !== parent.id || parentAttempt.workUnitId !== parent.workUnitId
        || unit.linkedRunId !== child.id || unit.ownerType !== "delegation_step" || unit.ownerId !== step.id
        || unit.workspaceId !== parentUnit.workspaceId || child.channelId !== parent.channelId || child.threadId !== parent.threadId
        || child.workflowStepId !== parent.workflowStepId || step.workflowStepId !== parent.workflowStepId
        || attempt !== undefined && attempt.workUnitId !== unit.id
        || (!parentStep && (step.parentDelegationStepId !== undefined || step.parentRunId !== step.rootRunId || step.depth !== 1 || reservation.parentReservationId !== undefined))
        || (parentStep !== undefined && (parentStep.rootRunId !== step.rootRunId || parentStep.childRunId !== parent.id
          || parentStep.depth + 1 !== step.depth || reservation.parentReservationId !== parentReservation?.id
          || !parentReservation || parentReservation.rootRunId !== step.rootRunId || parentReservation.childRunId !== parent.id));
      if (invalidLineage) issue("delegation.completion_lineage_invalid", step.id, child?.id);
      if (parent?.workflowStepId) {
        const workflowStep = db.prepare("SELECT workflow_id,workspace_id,channel_id,run_id FROM channel_workflow_steps WHERE id=?").get(parent.workflowStepId);
        if (!workflowStep || workflowStep.workflow_id !== step.workflowId || workflowStep.workspace_id !== unit?.workspaceId
          || workflowStep.channel_id !== child?.channelId || workflowStep.run_id !== step.rootRunId) issue("delegation.completion_lineage_invalid", step.id, child?.id, workflowStep);
      } else if (step.workflowId !== undefined) issue("delegation.completion_lineage_invalid", step.id, child?.id);
      for (const charge of ownCharges) {
        const chargedAttempt = this.ports.getWorkUnitAttempt(charge.attemptId);
        if (!reservation || charge.rootRunId !== step.rootRunId || charge.reservationId !== reservation.id
          || charge.runId !== child?.id || !chargedAttempt || chargedAttempt.workUnitId !== unit?.id) issue("delegation.completion_lineage_invalid", step.id, child?.id, charge);
      }
      if (["succeeded", "failed", "cancelled"].includes(step.state)) this.checkTerminal(read, at, issue);
      else if (results.length) issue("delegation.completion_result_invalid", step.id, child?.id);
      return read;
    });
    // Detect unowned charges, including a child charge falsely attributed to the root.
    for (const charge of charges) {
      const reservation = charge.reservationId ? reservationById.get(charge.reservationId) : undefined;
      const chargedRun = run(charge.runId), chargedAttempt = this.ports.getWorkUnitAttempt(charge.attemptId);
      if (charge.reservationId === undefined ? charge.runId !== charge.rootRunId
        : !reservation || reservation.rootRunId !== charge.rootRunId || reservation.childRunId !== charge.runId) {
        issue("delegation.completion_lineage_invalid", reservation?.delegationStepId, charge.runId, charge);
      }
      if (!chargedRun || !chargedAttempt || chargedAttempt.workUnitId !== chargedRun.workUnitId) issue("delegation.completion_lineage_invalid", undefined, charge.runId, charge);
    }
    this.checkSettledUsage(reads, issue);
    issues.sort((left, right) => delegationJson(left).localeCompare(delegationJson(right)));
    const canonical = { schemaVersion: 1 as const, rootRunIds, roots, steps: reads, issues,
      status: delegationCompletionRequiredStatusV1({ steps: reads, issues }) };
    return { ...canonical, fingerprint: delegationCompletionEvidenceFingerprintV1(canonical) };
  }

  private checkTerminal(read: DelegationCompletionStepReadV1, at: string,
    issue: (code: DelegationCompletionIssueCodeV1, stepId?: string, runId?: string, fact?: unknown) => void): void {
    const { step, reservation, childRun: run, workUnit: unit, attempt, hostCompletion: completion } = read;
    if (!run || !unit || !attempt || run.status !== step.state || unit.status !== step.state || attempt.status !== step.state
      || !run.endedAt || !unit.endedAt || !attempt.endedAt || ![run.endedAt, unit.endedAt, attempt.endedAt, step.completedAt!].every(value => validTime(value, at))) {
      issue("delegation.completion_fact_invalid", step.id, run?.id); return;
    }
    if (!completion?.drainedAt || !completion.effectCoverage || !validTime(completion.drainedAt, at)
      || completion.drainedAt < completion.registeredAt || completion.drainedAt > step.completedAt!
      || delegationJson(completion.source) !== delegationJson({ runId: run.id, ...attempt.sourceFence }) || read.quiescence !== "verified") {
      issue("delegation.completion_effects_unverified", step.id, run.id);
    }
    if (!reservation || reservation.state !== "settled" || !reservation.settlementDigest
      || !reservation.settledAt || !validTime(reservation.settledAt, at) || reservation.settledAt > step.completedAt!
      || read.charges.some(charge => !["measured", "cancelled_before_dispatch"].includes(charge.state))) {
      issue("delegation.completion_budget_unsettled", step.id, run.id); return;
    }
    const settlementDigest = delegationDigest({ kind: "verified_usage", childRunId: run.id, sourceFence: attempt.sourceFence });
    if (settlementDigest !== reservation.settlementDigest) issue("delegation.completion_usage_invalid", step.id, run.id);
    if (read.results.length !== 1 || !completion) { issue("delegation.completion_result_invalid", step.id, run.id); return; }
    const result = read.results[0]!, payload = result.payload;
    const expected: DelegationResultV1 = { schemaVersion: 1, kind: "delegation.result.v1", stepId: step.id,
      reservationId: reservation.id, rootRunId: step.rootRunId, parentRunId: step.parentRunId, childRunId: run.id,
      sourceFence: attempt.sourceFence, outcome: step.state as DelegationResultV1["outcome"], settlementDigest,
      evidenceRefs: delegationResultEvidenceRefsV1({ completion, reservation, charges: read.charges }) };
    if (!payload || delegationJson(payload) !== delegationJson(expected) || result.message.direction !== "child_to_parent"
      || result.artifactRunId !== run.id || result.message.createdAt !== step.completedAt
      || result.message.idempotencyKey !== `delegation-result:${step.id}:${attempt.sourceFence.attemptId}`
      || result.artifactPayloadSha256 !== result.artifactContentSha256 || result.message.digest !== result.artifactContentSha256
      || delegationDigest(payload) !== result.message.digest) issue("delegation.completion_result_invalid", step.id, run.id);
  }

  private checkSettledUsage(reads: readonly DelegationCompletionStepReadV1[],
    issue: (code: DelegationCompletionIssueCodeV1, stepId?: string, runId?: string, fact?: unknown) => void): void {
    const childrenByReservation = groupBy(reads, read => read.reservation?.parentReservationId);
    for (const read of reads) {
      const reservation = read.reservation;
      if (reservation?.state !== "settled") continue;
      let tokens = 0n, cost = 0n, costKnown = true, closed = true;
      for (const charge of read.charges) {
        if (charge.state === "cancelled_before_dispatch") continue;
        if (charge.state !== "measured") { closed = false; continue; }
        tokens += BigInt(charge.inputTokens!) + BigInt(charge.outputTokens!);
        cost += BigInt(charge.actualCostMicros ?? 0); costKnown &&= charge.actualCostMicros !== undefined;
      }
      for (const child of childrenByReservation.get(reservation.id) ?? []) {
        if (child.reservation!.state === "released") continue;
        if (child.reservation!.state !== "settled") { closed = false; continue; }
        tokens += BigInt(child.reservation!.settledTokenUsage!); cost += BigInt(child.reservation!.settledCostMicros ?? 0);
        costKnown &&= child.reservation!.settledCostMicros !== undefined;
      }
      if (!closed || BigInt(reservation.settledTokenUsage!) !== tokens
        || (costKnown ? reservation.settledCostMicros === undefined || BigInt(reservation.settledCostMicros) !== cost : reservation.settledCostMicros !== undefined)) {
        issue("delegation.completion_usage_invalid", read.step.id, read.childRun?.id);
      }
    }
  }

  private resultRead(message: DelegationMessageV1,
    issue: (code: DelegationCompletionIssueCodeV1, stepId?: string, runId?: string, fact?: unknown) => void): DelegationCompletionResultReadV1 {
    const size = this.context.database.prepare("SELECT length(CAST(sealed_payload_json AS BLOB)) AS bytes FROM artifacts WHERE id=?")
      .get(message.bodyArtifactId)?.bytes;
    if (typeof size === "number" && size > MAX_RESULT_BYTES) {
      issue("delegation.completion_result_invalid", message.delegationStepId, undefined, { id: message.bodyArtifactId, bytes: size });
      return { message, artifactId: message.bodyArtifactId };
    }
    const artifact = this.ports.getArtifact(message.bodyArtifactId);
    let payload: DelegationResultV1 | undefined, payloadSha256: string | undefined;
    if (artifact?.sealedPayload !== undefined) {
      try {
        const json = JSON.stringify(artifact.sealedPayload);
        payloadSha256 = createHash("sha256").update(json, "utf8").digest("hex");
        if (Buffer.byteLength(json, "utf8") > MAX_RESULT_BYTES) throw new Error("delegation.completion_result_too_large");
        payload = resultPayload(artifact.sealedPayload);
      } catch { issue("delegation.completion_result_invalid", message.delegationStepId, artifact.runId); }
    }
    return { message, artifactId: message.bodyArtifactId,
      ...(artifact ? { artifactRunId: artifact.runId, artifactContentSha256: artifact.contentSha256, artifactFingerprint: artifactFingerprint(artifact) } : {}),
      ...(payloadSha256 ? { artifactPayloadSha256: payloadSha256 } : {}), ...(payload ? { payload } : {}) };
  }

  private checkSealedArtifact(id: string, owner: string, digest: string,
    issue: (code: DelegationCompletionIssueCodeV1, stepId?: string, runId?: string, fact?: unknown) => void): void {
    const size = this.context.database.prepare("SELECT length(CAST(sealed_payload_json AS BLOB)) AS bytes FROM artifacts WHERE id=?").get(id)?.bytes;
    if (typeof size === "number" && size > 16_777_216) {
      issue("delegation.completion_fact_invalid", undefined, owner, { id, bytes: size }); return;
    }
    const artifact = this.ports.getArtifact(id);
    if (!artifact || artifact.runId !== owner || artifact.contentSha256 !== digest || artifact.sealedPayload === undefined
      || createHash("sha256").update(JSON.stringify(artifact.sealedPayload), "utf8").digest("hex") !== digest) {
      issue("delegation.completion_fact_invalid", undefined, owner, artifact ? artifactFingerprint(artifact) : { id });
    }
  }
}

/** Preserve source order and retain every fact, including invalid lineage edges. */
function groupBy<T>(rows: readonly T[], keyFor: (row: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFor(row);
    if (key === undefined) continue;
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  return groups;
}

function mergeCharges(left: readonly DelegationBudgetCharge[], right: readonly DelegationBudgetCharge[],
  order: ReadonlyMap<DelegationBudgetCharge, number>): DelegationBudgetCharge[] {
  const merged: DelegationBudgetCharge[] = [];
  let leftIndex = 0, rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCharge = left[leftIndex]!, rightCharge = right[rightIndex]!;
    if (leftCharge === rightCharge) { merged.push(leftCharge); leftIndex += 1; rightIndex += 1; }
    else if (order.get(leftCharge)! < order.get(rightCharge)!) { merged.push(leftCharge); leftIndex += 1; }
    else { merged.push(rightCharge); rightIndex += 1; }
  }
  while (leftIndex < left.length) merged.push(left[leftIndex++]!);
  while (rightIndex < right.length) merged.push(right[rightIndex++]!);
  return merged;
}

function runRead(run: RunSession): DelegationCompletionRunReadV1 {
  return { id: run.id, status: run.status, parentRunId: run.parentRunId, workUnitId: run.workUnitId, workflowStepId: run.workflowStepId,
    channelId: run.channelId, threadId: run.threadId, endedAt: run.endedAt, fingerprint: fingerprint(run) };
}
function unitRead(unit: WorkUnit): DelegationCompletionWorkUnitReadV1 {
  return { id: unit.id, workspaceId: unit.workspaceId, status: unit.status, ownerType: unit.ownerType, ownerId: unit.ownerId,
    linkedRunId: unit.linkedRunId, activeAttemptId: unit.activeAttemptId, endedAt: unit.endedAt, fingerprint: fingerprint(unit) };
}
function attemptRead(attempt: WorkUnitAttempt): DelegationCompletionAttemptReadV1 {
  return { sourceFence: toRuntimeAttemptFence(attempt), status: attempt.status, attemptNumber: attempt.attemptNumber,
    endedAt: attempt.endedAt, abortRequestedAt: attempt.abortRequestedAt, fingerprint: fingerprint(attempt) };
}
function fingerprint(value: unknown): string {
  // SQLite malformed-row fingerprints must remain deterministic for bigint values.
  const normalized: unknown = JSON.parse(JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? `${entry}n` : entry));
  return delegationDigest(normalized);
}
function artifactFingerprint(artifact: RunArtifact): string {
  const { sealedPayload, ...metadata } = artifact;
  return fingerprint({ ...metadata, payloadSha256: sealedPayload === undefined ? undefined : createHash("sha256").update(JSON.stringify(sealedPayload), "utf8").digest("hex") });
}
function validTime(value: string, at: string): boolean {
  try { return delegationTimestamp(value, "delegation.persisted_fact_invalid") <= at; } catch { return false; }
}
function resultPayload(value: unknown): DelegationResultV1 {
  const code = "delegation.persisted_fact_invalid";
  const row = delegationRecord(value, ["schemaVersion", "kind", "stepId", "reservationId", "rootRunId", "parentRunId", "childRunId", "sourceFence", "outcome", "settlementDigest", "evidenceRefs"], code);
  if (row.schemaVersion !== 1 || row.kind !== "delegation.result.v1" || !["succeeded", "failed", "cancelled"].includes(String(row.outcome))
    || !Array.isArray(row.evidenceRefs) || row.evidenceRefs.length > MAX_CHARGES + 2) throw new Error("delegation.completion_result_invalid");
  const refs: DelegationResultEvidenceRefV1[] = row.evidenceRefs.map(value => {
    const ref = delegationRecord(value, ["kind", "id", "digest"], code);
    if (!["host_attempt_completion", "delegation_budget_reservation", "delegation_budget_charge"].includes(String(ref.kind))
      || typeof ref.digest !== "string" || !/^[a-f0-9]{64}$/u.test(ref.digest)) throw new Error("delegation.completion_result_invalid");
    return { kind: ref.kind as DelegationResultEvidenceRefV1["kind"], id: delegationId(ref.id, code), digest: ref.digest };
  });
  const settlementDigest = delegationId(row.settlementDigest, code);
  if (!/^[a-f0-9]{64}$/u.test(settlementDigest)) throw new Error("delegation.completion_result_invalid");
  return { schemaVersion: 1, kind: "delegation.result.v1", stepId: delegationId(row.stepId, code), reservationId: delegationId(row.reservationId, code),
    rootRunId: delegationId(row.rootRunId, code), parentRunId: delegationId(row.parentRunId, code), childRunId: delegationId(row.childRunId, code),
    sourceFence: delegationFence(row.sourceFence), outcome: row.outcome as DelegationResultV1["outcome"], settlementDigest, evidenceRefs: refs };
}
