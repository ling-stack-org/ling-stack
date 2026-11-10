import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { SQLOutputValue } from "node:sqlite";
import type { RunStore } from "../../run-types.js";
import type { HostRunCapacityReservation } from "../../host-run-capacity-types.js";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import { isHostCapacityWorkspaceDatabaseConnectionCurrent,
  type HostRunCapacityWorkspaceIdentitySnapshot } from "../../host-run-capacity-workspace-identity.js";
import type { AttachRuntimeHostCapacityReservationResult, PrepareRuntimeHostCapacityAttemptResult,
  PrepareRuntimeHostCapacityDelegationSpawnResult, PrepareRuntimeHostCapacityReleaseResult,
  PrepareRuntimeHostCapacityWorkflowStartResult, PrepareRuntimeHostCapacityDelegationPendingResult, RuntimeHostCapacityIntentRecord,
  RuntimeHostCapacityPendingRecord,
  RuntimeHostCapacityReleaseRecord } from "../../runtime-host-capacity-types.js";
import type { RuntimeHostCapacityApprovalResumePendingInput, RuntimeHostCapacityUserInputPendingInput } from "../../runtime-host-capacity-types.js";
import { approvalResumeCapacityAuthority, userInputCapacityAuthority, continuationCapacityAuthority,
  type HostCapacityContinuationPorts } from "./runtime-host-capacity-continuations.js";
import { readNumber, readString, rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import { withSqliteSnapshotParentTransaction } from "./read-snapshot.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { readHostOperationBlockers } from "./host-operation-journal-store.js";
import { isRuntimeHostCapacityPausedStopProof, readRuntimeHostCapacityPausedStopProof } from "./runtime-host-capacity-stop-proof.js";

type Ports = Pick<RunStore, "getRun" | "getTask" | "getChannel" | "getHostAttemptCompletion"
  | "releaseResourceLeasesForAttempt" | "releaseRuntimeSemaphoreSlotsForAttempt"> & HostCapacityContinuationPorts;
type Row = Record<string, SQLOutputValue>;
type LocalExecutionAdmission = Readonly<{
  readonly providerKey: string;
  readonly runnerKey: string;
  readonly tools: readonly string[];
}>;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceFields = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;
const ownerKey = (source: HostOperationSource): string => hash(sourceFields.map(key => source[key]));
function timestamp(value: unknown): asserts value is string {
  if (!isTimestamp(value)) throw new TypeError("runtime_host_capacity.invalid_timestamp");
}
function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try { return object(JSON.parse(value)); }
  catch { return undefined; }
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/u.test(value))
    throw new TypeError("runtime_host_capacity.invalid_identity");
}
function validateSource(source: HostOperationSource): void {
  for (const key of sourceFields) text(source?.[key]);
}
function preparedExecutionIndependentSnapshot(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    const snapshot = { ...(parsed as Record<string, unknown>) };
    delete snapshot.runnerExecutionInput;
    return snapshot;
  } catch {
    return value;
  }
}
function sourceFromRow(row: Row): HostOperationSource | undefined {
  if (row.run_id === null && row.work_unit_id === null && row.attempt_id === null
    && row.runtime_instance_id === null && row.fencing_token === null) return undefined;
  return Object.freeze({ runId: readString(row, "run_id"), workUnitId: readString(row, "work_unit_id"),
    attemptId: readString(row, "attempt_id"), runtimeInstanceId: readString(row, "runtime_instance_id"),
    fencingToken: readString(row, "fencing_token") });
}

/** Workspace journal only. A receipt does not replace the owning Run admission or SDK authority checks. */
export class SqliteRuntimeHostCapacityStore {
  private readonly identity: HostRunCapacityWorkspaceIdentitySnapshot;

  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    identity: HostRunCapacityWorkspaceIdentitySnapshot) {
    this.identity = Object.freeze({ ...identity });
    this.assertIdentity();
  }

  getWorkspaceIdentity(): HostRunCapacityWorkspaceIdentitySnapshot {
    this.assertIdentity();
    return this.identity;
  }

  assertOutsideTransaction(): void {
    if (this.context.database.isTransaction === true) throw new Error("runtime_host_capacity.nested_handoff");
    if (this.context.database.isTransaction === false) return;
    this.context.database.exec("BEGIN DEFERRED");
    this.context.database.exec("ROLLBACK");
  }

  getIntent(intentId: string): RuntimeHostCapacityIntentRecord | undefined {
    text(intentId);
    this.assertIdentity();
    const row = this.context.database.prepare("SELECT * FROM runtime_host_capacity_intents WHERE intent_id=?").get(intentId);
    return row ? this.mapIntent(row) : undefined;
  }

  getAttemptIntent(source: HostOperationSource): RuntimeHostCapacityIntentRecord | undefined {
    validateSource(source);
    this.assertIdentity();
    const row = this.context.database.prepare("SELECT * FROM runtime_host_capacity_intents WHERE attempt_id=?").get(source.attemptId);
    if (!row) return undefined;
    const record = this.mapIntent(row);
    return isDeepStrictEqual(record.source, source) ? record : undefined;
  }

  prepareApprovalResumePending(input: RuntimeHostCapacityApprovalResumePendingInput): PrepareRuntimeHostCapacityDelegationPendingResult {
    timestamp(input.now);
    return this.prepareContinuationPending("approval_resume_pending", input.now,
      () => approvalResumeCapacityAuthority(this.ports, this.identity.workspaceId, input));
  }

  prepareUserInputContinuation(input: RuntimeHostCapacityUserInputPendingInput): PrepareRuntimeHostCapacityDelegationPendingResult {
    timestamp(input.now);
    return this.prepareContinuationPending("user_input_continuation", input.now,
      () => userInputCapacityAuthority(this.ports, this.identity.workspaceId, input));
  }

  private prepareContinuationPending(ownerKind: "approval_resume_pending" | "user_input_continuation", now: string,
    readAuthority: () => { readonly ownerKey: string; readonly authorityDigest: string } | undefined): PrepareRuntimeHostCapacityDelegationPendingResult {
    return this.write<PrepareRuntimeHostCapacityDelegationPendingResult>(() => {
      const authority = readAuthority();
      if (!authority) return { status: "changed" };
      const row = this.context.database.prepare("SELECT * FROM runtime_host_capacity_intents WHERE owner_kind=? AND owner_key=?")
        .get(ownerKind, authority.ownerKey);
      if (row) {
        const record = this.mapIntent(row);
        return !record.source && !record.dispatchedAt && !record.revokedAt && !this.getRelease(record.intent.intentId)
          && record.createdAt <= now && (!record.reservation || record.reservation.reservedAt <= now)
          && record.intent.authorityDigest === authority.authorityDigest
          ? { status: "duplicate", record: record as RuntimeHostCapacityPendingRecord } : { status: "changed" };
      }
      const intentId = randomUUID();
      this.context.database.prepare(`INSERT INTO runtime_host_capacity_intents
        (intent_id,workspace_id,workspace_key,canonical_cwd,database_path,database_file_identity,owner_kind,owner_key,authority_digest,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(intentId, this.identity.workspaceId, this.identity.workspaceKey,
          this.identity.canonicalCwd, this.identity.databasePath, this.identity.databaseFileIdentity,
          ownerKind, authority.ownerKey, authority.authorityDigest, now);
      return { status: "prepared", record: this.getIntent(intentId)! as RuntimeHostCapacityPendingRecord };
    });
  }

  bindApprovalResumeSourceWithinTransaction(input: RuntimeHostCapacityApprovalResumePendingInput & {
    readonly intentId: string; readonly token: string; readonly source: HostOperationSource;
  }): boolean {
    const record = this.getIntent(input.intentId);
    if (!record || record.intent.ownerKind !== "approval_resume_pending") return false;
    const authority = approvalResumeCapacityAuthority(this.ports, this.identity.workspaceId, input, input.source);
    return !!authority && authority.ownerKey === record.intent.ownerKey
      && this.bindContinuationSourceWithinTransaction(input);
  }

  bindUserInputSourceWithinTransaction(input: { readonly intentId: string; readonly token: string;
    readonly threadId: string; readonly deliveryId: string; readonly source: HostOperationSource; readonly now: string }): boolean {
    const record = this.getIntent(input.intentId), binding = this.ports.getUserInputContinuationBinding(input.threadId, input.deliveryId);
    if (!record || record.intent.ownerKind !== "user_input_continuation" || !binding || binding.runId !== input.source.runId
      || binding.hostCapacity?.intentId !== input.intentId || binding.hostCapacity.dispatchToken !== input.token) return false;
    return this.bindContinuationSourceWithinTransaction(input);
  }

  private bindContinuationSourceWithinTransaction(input: { readonly intentId: string; readonly token: string;
    readonly source: HostOperationSource; readonly now: string }): boolean {
    text(input.intentId); text(input.token); validateSource(input.source); timestamp(input.now);
    if (!this.context.database.isTransaction) throw new Error("runtime_host_capacity.transaction_required");
    const record = this.getIntent(input.intentId), row = this.readSource(input.source);
    const authority = record && continuationCapacityAuthority(this.ports, this.identity.workspaceId, record, input.now, input.source);
    if (!record?.reservation || record.source || record.dispatchToken !== input.token || record.dispatchedAt || record.revokedAt
      || record.reservation.reservedAt > input.now || this.getRelease(input.intentId) || !row
      || !this.isDispatchableSource(row, record.intent.ownerKind) || !this.isPrestart(row, record.intent.ownerKind)
      || this.hasDispatchFacts(input.source) || !authority || authority.authorityDigest !== record.intent.authorityDigest
      || authority.ownerKey !== record.intent.ownerKey) return false;
    return Number(this.context.database.prepare(`UPDATE runtime_host_capacity_intents
      SET run_id=?,work_unit_id=?,attempt_id=?,runtime_instance_id=?,fencing_token=?
      WHERE intent_id=? AND attempt_id IS NULL AND dispatched_at IS NULL AND revoked_at IS NULL`).run(
        ...sourceFields.map(key => input.source[key]), input.intentId).changes) === 1;
  }

  consumeDispatchGate(input: Parameters<SqliteRuntimeHostCapacityStore["consumeDispatchGateWithinTransaction"]>[0]): boolean {
    return this.write(() => this.consumeDispatchGateWithinTransaction(input));
  }

  prepareAttempt(input: { readonly source: HostOperationSource; readonly now: string }): PrepareRuntimeHostCapacityAttemptResult {
    return this.prepareOrdinaryAttempt(input, false);
  }

  prepareExecution(input: { readonly source: HostOperationSource; readonly now: string }): PrepareRuntimeHostCapacityAttemptResult {
    return this.prepareOrdinaryAttempt(input, true);
  }

  private prepareOrdinaryAttempt(input: { readonly source: HostOperationSource; readonly now: string }, execution: boolean): PrepareRuntimeHostCapacityAttemptResult {
    validateSource(input.source); timestamp(input.now);
    return this.write<PrepareRuntimeHostCapacityAttemptResult>(() => {
      const source = this.readSource(input.source);
      if (!source || !(execution ? this.isOrdinaryExecutionSource(source) : this.isFirstPiSource(source))
        || !this.isPrestart(source, "attempt") || this.hasDispatchFacts(input.source))
        return { status: "changed" };
      const authorityDigest = this.authorityDigest(source);
      const existing = this.context.database.prepare("SELECT * FROM runtime_host_capacity_intents WHERE attempt_id=?").get(input.source.attemptId);
      if (existing) {
        const record = this.mapIntent(existing);
        return isDeepStrictEqual(record.source, input.source) && record.intent.authorityDigest === authorityDigest
          && record.createdAt <= input.now && (!record.reservation || record.reservation.reservedAt <= input.now)
          && !record.dispatchedAt && !record.revokedAt && !this.getRelease(record.intent.intentId)
          ? { status: "duplicate", record } : { status: "changed" };
      }
      if (this.hasActiveResources(input.source)) return { status: "changed" };
      const intentId = randomUUID();
      this.context.database.prepare(`INSERT INTO runtime_host_capacity_intents
        (intent_id,workspace_id,workspace_key,canonical_cwd,database_path,database_file_identity,owner_kind,owner_key,
          authority_digest,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,created_at)
        VALUES (?,?,?,?,?,?,'attempt',?,?,?,?,?,?,?,?)`).run(intentId, this.identity.workspaceId, this.identity.workspaceKey,
          this.identity.canonicalCwd, this.identity.databasePath, this.identity.databaseFileIdentity, ownerKey(input.source),
          authorityDigest, ...sourceFields.map(key => input.source[key]), input.now);
      return { status: "prepared", record: this.getIntent(intentId)! };
    });
  }

  /** A workflow start has its own owner kind while retaining the real Attempt fence. */
  prepareWorkflowStart(input: { readonly source: HostOperationSource; readonly now: string }): PrepareRuntimeHostCapacityWorkflowStartResult {
    validateSource(input.source); timestamp(input.now);
    return this.write<PrepareRuntimeHostCapacityWorkflowStartResult>(() => {
      const source = this.readSource(input.source);
      if (!source || !this.isWorkflowStartSource(source) || !this.isPrestart(source, "workflow_start") || this.hasDispatchFacts(input.source)) {
        return { status: "changed" };
      }
      const authorityDigest = this.authorityDigest(source, true);
      const existing = this.context.database.prepare("SELECT * FROM runtime_host_capacity_intents WHERE attempt_id=?").get(input.source.attemptId);
      if (existing) {
        const record = this.mapIntent(existing);
        return isDeepStrictEqual(record.source, input.source) && record.intent.ownerKind === "workflow_start"
          && record.intent.authorityDigest === authorityDigest && record.createdAt <= input.now
          && (!record.reservation || record.reservation.reservedAt <= input.now)
          && !record.dispatchedAt && !record.revokedAt && !this.getRelease(record.intent.intentId)
          ? { status: "duplicate", record } : { status: "changed" };
      }
      if (!this.hasWorkflowStartPreparation(input.source, input.now)) {
        return { status: "changed" };
      }
      const intentId = randomUUID();
      this.context.database.prepare(`INSERT INTO runtime_host_capacity_intents
        (intent_id,workspace_id,workspace_key,canonical_cwd,database_path,database_file_identity,owner_kind,owner_key,
          authority_digest,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,created_at)
        VALUES (?,?,?,?,?,?,'workflow_start',?,?,?,?,?,?,?,?)`).run(intentId, this.identity.workspaceId, this.identity.workspaceKey,
          this.identity.canonicalCwd, this.identity.databasePath, this.identity.databaseFileIdentity,
          ownerKey(input.source), authorityDigest, ...sourceFields.map(key => input.source[key]), input.now);
      return { status: "prepared", record: this.getIntent(intentId)! };
    });
  }

  /** A delegated child already has an Attempt when Host admission begins. */
  prepareDelegationSpawn(input: { readonly source: HostOperationSource; readonly now: string }): PrepareRuntimeHostCapacityDelegationSpawnResult {
    validateSource(input.source); timestamp(input.now);
    return this.write<PrepareRuntimeHostCapacityDelegationSpawnResult>(() => {
      const source = this.readSource(input.source);
      if (!source || !this.isDelegationSpawnSource(source) || !this.isPrestart(source, "delegation_spawn") || this.hasDispatchFacts(input.source)) {
        return { status: "changed" };
      }
      const authorityDigest = this.authorityDigest(source);
      const existing = this.context.database.prepare("SELECT * FROM runtime_host_capacity_intents WHERE attempt_id=?").get(input.source.attemptId);
      if (existing) {
        const record = this.mapIntent(existing);
        return isDeepStrictEqual(record.source, input.source) && record.intent.ownerKind === "delegation_spawn"
          && record.intent.authorityDigest === authorityDigest && record.createdAt <= input.now
          && (!record.reservation || record.reservation.reservedAt <= input.now)
          && !record.dispatchedAt && !record.revokedAt && !this.getRelease(record.intent.intentId)
          ? { status: "duplicate", record } : { status: "changed" };
      }
      const intentId = randomUUID();
      this.context.database.prepare(`INSERT INTO runtime_host_capacity_intents
        (intent_id,workspace_id,workspace_key,canonical_cwd,database_path,database_file_identity,owner_kind,owner_key,
          authority_digest,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,created_at)
        VALUES (?,?,?,?,?,?,'delegation_spawn',?,?,?,?,?,?,?,?)`).run(intentId, this.identity.workspaceId, this.identity.workspaceKey,
        this.identity.canonicalCwd, this.identity.databasePath, this.identity.databaseFileIdentity,
        ownerKey(input.source), authorityDigest, ...sourceFields.map(key => input.source[key]), input.now);
      return { status: "prepared", record: this.getIntent(intentId)! };
    });
  }

  prepareDelegationPending(input: { readonly admissionId: string; readonly now: string }): PrepareRuntimeHostCapacityDelegationPendingResult {
    text(input.admissionId); timestamp(input.now);
    return this.write<PrepareRuntimeHostCapacityDelegationPendingResult>(() => {
      const row = this.context.database.prepare(`SELECT a.*,r.child_run_id,s.id AS step_id,s.revision AS step_revision,
        r.root_run_id,run.work_unit_id,run.workspace_id,run.status AS run_status,u.status AS unit_status
        FROM runtime_delegation_spawn_admissions a
        JOIN delegation_budget_reservations r ON r.id=a.reservation_id
        JOIN delegation_steps s ON s.id=r.delegation_step_id
        JOIN run_sessions run ON run.id=r.child_run_id
        JOIN work_units u ON u.id=run.work_unit_id
        WHERE a.admission_id=?`).get(input.admissionId);
      if (!row || row.workspace_id !== this.identity.workspaceId || row.status !== "pending"
        || row.run_status !== "queued" || row.unit_status !== "queued") return { status: "changed" };
      const authorityDigest = hash([row.child_run_id, row.work_unit_id, row.step_id, row.step_revision, row.runtime_instance_id]);
      const existing = this.context.database.prepare("SELECT * FROM runtime_host_capacity_intents WHERE owner_kind='delegation_spawn' AND owner_key=?").get(input.admissionId);
      if (existing) {
        const record = this.mapIntent(existing);
        return record.intent.authorityDigest === authorityDigest && !record.source ? { status: "duplicate", record: record as RuntimeHostCapacityPendingRecord } : { status: "changed" };
      }
      const intentId = randomUUID();
      this.context.database.prepare(`INSERT INTO runtime_host_capacity_intents
        (intent_id,workspace_id,workspace_key,canonical_cwd,database_path,database_file_identity,owner_kind,owner_key,authority_digest,created_at)
        VALUES (?,?,?,?,?,?, 'delegation_spawn',?,?,?)`).run(intentId, this.identity.workspaceId, this.identity.workspaceKey,
        this.identity.canonicalCwd, this.identity.databasePath, this.identity.databaseFileIdentity, input.admissionId, authorityDigest, input.now);
      // Link the workspace intent before leaving the transaction. The Host
      // reservation is attached in a later handoff and is the point at which
      // the durable admission becomes `reserved`.
      const linked = this.context.database.prepare(`UPDATE runtime_delegation_spawn_admissions
        SET host_intent_id=?,updated_at=? WHERE admission_id=? AND status='pending' AND host_intent_id IS NULL`).run(
        intentId, input.now, input.admissionId);
      if (Number(linked.changes) !== 1) return { status: "changed" };
      return { status: "prepared", record: this.getIntent(intentId)! as RuntimeHostCapacityPendingRecord };
    });
  }

  /** Observation of an exact Host reservation is safe after cancellation; it does not consume a gate. */
  attachReservation(input: { readonly intentId: string; readonly reservation: HostRunCapacityReservation;
    readonly now: string }): AttachRuntimeHostCapacityReservationResult {
    text(input.intentId); timestamp(input.now);
    return this.write<AttachRuntimeHostCapacityReservationResult>(() => {
      const record = this.getIntent(input.intentId), reservation = input.reservation;
      if (!record || reservation?.state !== "held" || !isDeepStrictEqual(record.intent, reservation.intent)
        || !this.validReservation(reservation) || reservation.reservedAt > input.now
        || reservation.reservedAt < record.createdAt) return { status: "changed" };
      const receipt = { reservationId: reservation.reservationId, token: reservation.token, intent: reservation.intent,
        policyRevision: reservation.policyRevision, reservedAt: reservation.reservedAt };
      if (record.reservation) return isDeepStrictEqual(record.reservation, receipt)
        ? { status: "duplicate", record } : { status: "changed" };
      this.context.database.prepare(`UPDATE runtime_host_capacity_intents SET reservation_id=?,reservation_token=?,
        host_policy_revision=?,reserved_at=?,dispatch_token=? WHERE intent_id=? AND reservation_id IS NULL`)
        .run(reservation.reservationId, reservation.token, reservation.policyRevision, reservation.reservedAt,
          randomBytes(32).toString("hex"), input.intentId);
      if (!record.source && record.intent.ownerKind === "delegation_spawn") {
        const linked = this.context.database.prepare(`UPDATE runtime_delegation_spawn_admissions SET status='reserved',updated_at=?
          WHERE admission_id=? AND host_intent_id=? AND status='pending'`).run(
          input.now, record.intent.ownerKey, input.intentId);
        if (Number(linked.changes) !== 1) return { status: "changed" };
      }
      return { status: "attached", record: this.getIntent(input.intentId)! };
    });
  }

  /** The admission owner must consume this in the same transaction as its complete local resource group. */
  consumeDispatchGateWithinTransaction(input: { readonly intentId: string; readonly token: string;
    readonly source: HostOperationSource; readonly now: string }): boolean {
    text(input.intentId); text(input.token); validateSource(input.source); timestamp(input.now);
    if (!this.context.database.isTransaction) throw new Error("runtime_host_capacity.transaction_required");
    this.assertIdentity();
    const record = this.getIntent(input.intentId), source = this.readSource(input.source);
    if (!record?.reservation || record.dispatchToken !== input.token || record.dispatchedAt || record.revokedAt
      || !record.source || !isDeepStrictEqual(record.source, input.source) || record.reservation.reservedAt > input.now
      || this.getRelease(input.intentId) || !source || !this.isDispatchableSource(source, record.intent.ownerKind)
      || !this.isPrestart(source, record.intent.ownerKind) || this.hasDispatchFacts(input.source)
      || !this.matchesAuthority(record, source, input.now)
      || !this.hasCompleteLocalAdmission(input.source, input.now, record.intent.ownerKind)) return false;
    const changed = this.context.database.prepare(`UPDATE runtime_host_capacity_intents SET dispatched_at=?
      WHERE intent_id=? AND dispatch_token=? AND dispatched_at IS NULL AND revoked_at IS NULL AND reservation_id IS NOT NULL`)
      .run(input.now, input.intentId, input.token);
    return Number(changed.changes) === 1;
  }

  bindDelegationSourceWithinTransaction(input: { readonly intentId: string; readonly source: HostOperationSource; readonly now: string }): boolean {
    text(input.intentId); validateSource(input.source); timestamp(input.now);
    if (!this.context.database.isTransaction) throw new Error("runtime_host_capacity.transaction_required");
    const record = this.getIntent(input.intentId);
    if (!record || record.intent.ownerKind !== "delegation_spawn" || record.source || record.dispatchedAt || record.revokedAt) return false;
    const row = this.readSource(input.source);
    if (!row || !this.isDelegationSpawnSource(row) || !this.isPrestart(row, "delegation_spawn")
      || this.hasDispatchFacts(input.source)) return false;
    // A pending delegation intent intentionally uses the child identity as its
    // digest because no Attempt existed when Host capacity was reserved. Bind
    // the later fence against that same durable admission identity.
    const admission = this.context.database.prepare(`SELECT a.reservation_id,a.expected_step_revision,a.runtime_instance_id,
        r.child_run_id,s.id AS step_id,s.revision AS step_revision,run.work_unit_id
      FROM runtime_delegation_spawn_admissions a
      JOIN delegation_budget_reservations r ON r.id=a.reservation_id
      JOIN delegation_steps s ON s.id=r.delegation_step_id
      JOIN run_sessions run ON run.id=r.child_run_id
      WHERE a.admission_id=? AND a.host_intent_id=? AND a.status='reserved'`).get(record.intent.ownerKey, input.intentId);
    if (!admission || admission.child_run_id !== input.source.runId || admission.work_unit_id !== input.source.workUnitId
      || admission.step_id !== row.workflow_step_id || admission.step_revision !== admission.expected_step_revision
      || admission.runtime_instance_id !== input.source.runtimeInstanceId
      || record.intent.authorityDigest !== hash([admission.child_run_id, admission.work_unit_id, admission.step_id,
        admission.step_revision, admission.runtime_instance_id])) return false;
    const changed = this.context.database.prepare(`UPDATE runtime_host_capacity_intents SET run_id=?,work_unit_id=?,attempt_id=?,runtime_instance_id=?,fencing_token=?
      WHERE intent_id=? AND attempt_id IS NULL AND dispatched_at IS NULL AND revoked_at IS NULL`).run(
      input.source.runId, input.source.workUnitId, input.source.attemptId, input.source.runtimeInstanceId, input.source.fencingToken, input.intentId);
    return Number(changed.changes) === 1;
  }

  prepareNoDispatchRelease(input: { readonly intentId: string; readonly now: string }): PrepareRuntimeHostCapacityReleaseResult {
    text(input.intentId); timestamp(input.now);
    return this.write<PrepareRuntimeHostCapacityReleaseResult>(() => {
    const record = this.getIntent(input.intentId);
      if (!record?.reservation || record.dispatchedAt || record.reservation.reservedAt > input.now) return { status: "changed" };
      const existing = this.getRelease(input.intentId);
      if (existing) return existing.kind === "no_dispatch" ? { status: "duplicate", release: existing } : { status: "changed" };
      if (!record.source) {
        this.context.database.prepare("UPDATE runtime_host_capacity_intents SET revoked_at=? WHERE intent_id=? AND dispatched_at IS NULL AND revoked_at IS NULL")
          .run(input.now, input.intentId);
        return this.writeRelease(record, "no_dispatch", { dispatchToken: record.dispatchToken, revokedAt: input.now, noHostLifetime: true }, input.now);
      }
      const source = this.readSource(record.source);
      if (!source || !this.isDispatchableSource(source, record.intent.ownerKind)
        || source.attempt_started_at !== null || this.hasDispatchFacts(record.source)) return { status: "changed" };
      this.context.database.prepare(`UPDATE runtime_host_capacity_intents SET revoked_at=?
        WHERE intent_id=? AND dispatched_at IS NULL AND revoked_at IS NULL`).run(input.now, input.intentId);
      this.ports.releaseResourceLeasesForAttempt(record.source, input.now, "host-capacity-no-dispatch");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(record.source, input.now, "host-capacity-no-dispatch");
      if (this.hasActiveResources(record.source)) throw new Error("runtime_host_capacity.resource_release_unverified");
      return this.writeRelease(record, "no_dispatch", {
        dispatchToken: record.dispatchToken, revokedAt: input.now, noHostLifetime: true }, input.now);
    });
  }

  prepareStoppedRelease(input: { readonly intentId: string; readonly now: string }): PrepareRuntimeHostCapacityReleaseResult {
    text(input.intentId); timestamp(input.now);
    return this.write<PrepareRuntimeHostCapacityReleaseResult>(() => {
      const record = this.getIntent(input.intentId);
      if (!record?.reservation || !record.dispatchedAt || record.dispatchedAt > input.now || record.revokedAt)
        return { status: "changed" };
      const existing = this.getRelease(input.intentId);
      if (existing) return existing.kind === "stopped" ? { status: "duplicate", release: existing } : { status: "changed" };
      if (!record.source) return { status: "changed" };
      const source = this.readSource(record.source), completion = this.ports.getHostAttemptCompletion(record.source);
      if (!source || !this.isDispatchableSource(source, record.intent.ownerKind)
        || !isTimestamp(source.attempt_started_at) || source.attempt_started_at < record.dispatchedAt
        || !isTimestamp(source.attempt_ended_at) || source.attempt_ended_at < source.attempt_started_at || source.attempt_ended_at > input.now
        || this.hasActiveResources(record.source)
        || readHostOperationBlockers(this.context.database, record.source, input.now).length) return { status: "changed" };
      const pausedProof = ["yielded", "lost"].includes(String(source.attempt_status))
        ? readRuntimeHostCapacityPausedStopProof(this.context, this.ports, {
            source: record.source,
            dispatchedAt: record.dispatchedAt,
            now: input.now,
          })
        : undefined;
      if (pausedProof) return this.writeRelease(record, "stopped", pausedProof, input.now);
      if (!["succeeded", "failed", "cancelled"].includes(String(source.attempt_status))
        || !isTimestamp(completion?.registeredAt) || completion.registeredAt < record.dispatchedAt
        || !isTimestamp(completion.drainedAt) || completion.drainedAt < completion.registeredAt || completion.drainedAt > input.now
        || !["pi_no_tools_v1", "pi_tracked_tools_v1", "native_journal_v1"].includes(completion.effectCoverage ?? "")
        || !isDeepStrictEqual(completion.source, record.source)
        || this.hasPendingObligations(record.source)) return { status: "changed" };
      let settlements: ReadonlyMap<string, string>;
      try { settlements = assertUserInputDurableQuiescence(this.context.database, record.source.runId, record.source, Date.parse(input.now)); }
      catch { return { status: "changed" }; }
      return this.writeRelease(record, "stopped", {
        attemptStatus: source.attempt_status, attemptStartedAt: source.attempt_started_at, attemptEndedAt: source.attempt_ended_at, completion,
        settlements: [...settlements].sort(([left], [right]) => left.localeCompare(right)) }, input.now);
    });
  }

  getRelease(intentId: string): RuntimeHostCapacityReleaseRecord | undefined {
    text(intentId);
    this.assertIdentity();
    const row = this.context.database.prepare("SELECT * FROM runtime_host_capacity_releases WHERE intent_id=?").get(intentId);
    if (!row) return undefined;
    const proof = object(JSON.parse(readString(row, "proof_json")) as unknown), record = this.getIntent(intentId);
    const evidence = object(proof?.evidence), createdAt = readString(row, "created_at"), acknowledgedAt = row.acknowledged_at;
    if (!proof || hash(proof) !== row.proof_digest || !["no_dispatch", "stopped"].includes(String(row.kind))
      || !record?.reservation || proof.schemaVersion !== 1 || proof.kind !== row.kind || proof.createdAt !== createdAt
      || !isDeepStrictEqual(proof.intent, record.intent) || !isDeepStrictEqual(proof.reservation, record.reservation)
      || !isDeepStrictEqual(proof.source, record.source) || proof.dispatchedAt !== (record.dispatchedAt ?? null)
      || row.reservation_id !== record.reservation.reservationId || row.reservation_token !== record.reservation.token
      || !isTimestamp(createdAt) || createdAt < record.reservation.reservedAt
      || (acknowledgedAt !== null && (!isTimestamp(acknowledgedAt) || acknowledgedAt < createdAt)) || !evidence)
      throw new Error("runtime_host_capacity.release_invalid");
    if (row.kind === "no_dispatch") {
      if (record.dispatchedAt || record.revokedAt !== createdAt || evidence.revokedAt !== createdAt
        || evidence.dispatchToken !== record.dispatchToken || evidence.noHostLifetime !== true)
        throw new Error("runtime_host_capacity.release_invalid");
    } else {
      if (!record.dispatchedAt || record.revokedAt || !record.source) throw new Error("runtime_host_capacity.release_invalid");
      const stopInput = { source: record.source, dispatchedAt: record.dispatchedAt, now: createdAt };
      if (!isRuntimeHostCapacityPausedStopProof(evidence, stopInput)) {
        const completion = object(evidence.completion);
        if (!completion || completion.schemaVersion !== 1
          || !isDeepStrictEqual(completion.source, record.source)
          || !isTimestamp(evidence.attemptStartedAt) || evidence.attemptStartedAt < record.dispatchedAt
          || !isTimestamp(evidence.attemptEndedAt) || evidence.attemptEndedAt < evidence.attemptStartedAt || evidence.attemptEndedAt > createdAt
          || !["succeeded", "failed", "cancelled"].includes(String(evidence.attemptStatus))
          || !isTimestamp(completion.registeredAt) || completion.registeredAt < record.dispatchedAt
          || !isTimestamp(completion.drainedAt) || completion.drainedAt < completion.registeredAt || completion.drainedAt > createdAt
          || !["pi_no_tools_v1", "pi_tracked_tools_v1", "native_journal_v1"].includes(String(completion.effectCoverage))
          || !Array.isArray(evidence.settlements))
          throw new Error("runtime_host_capacity.release_invalid");
      }
    }
    return Object.freeze({ intentId: readString(row, "intent_id"), reservationId: readString(row, "reservation_id"),
      token: readString(row, "reservation_token"), kind: row.kind as RuntimeHostCapacityReleaseRecord["kind"],
      proofDigest: readString(row, "proof_digest"), createdAt: readString(row, "created_at"),
      ...(typeof row.acknowledged_at === "string" ? { acknowledgedAt: row.acknowledged_at } : {}) });
  }

  listPendingReleases(limit = 100): readonly RuntimeHostCapacityReleaseRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("runtime_host_capacity.invalid_limit");
    this.assertIdentity();
    return this.context.database.prepare(`SELECT intent_id FROM runtime_host_capacity_releases
      WHERE acknowledged_at IS NULL ORDER BY created_at,intent_id LIMIT ?`).all(limit).map(row => this.getRelease(String(row.intent_id))!);
  }

  acknowledgeRelease(input: { readonly intentId: string; readonly reservation: HostRunCapacityReservation; readonly now: string }): boolean {
    text(input.intentId); timestamp(input.now);
    return this.write(() => {
      const record = this.getIntent(input.intentId), release = this.getRelease(input.intentId), reservation = input.reservation;
      if (!record || !release || reservation?.state !== "released" || !this.validReservation(reservation)
        || !isDeepStrictEqual(record.intent, reservation.intent) || reservation.reservationId !== release.reservationId
        || reservation.token !== release.token || reservation.releaseKind !== release.kind
        || reservation.releaseProofDigest !== release.proofDigest || !reservation.releasedAt || reservation.releasedAt > input.now
        || reservation.releasedAt < release.createdAt || release.createdAt > input.now
        || !Number.isFinite(Date.parse(reservation.releasedAt)) || new Date(reservation.releasedAt).toISOString() !== reservation.releasedAt)
        return false;
      if (release.acknowledgedAt) return true;
      return Number(this.context.database.prepare(`UPDATE runtime_host_capacity_releases SET acknowledged_at=?
        WHERE intent_id=? AND acknowledged_at IS NULL`).run(input.now, input.intentId).changes) === 1;
    });
  }

  private writeRelease(record: RuntimeHostCapacityIntentRecord, kind: RuntimeHostCapacityReleaseRecord["kind"],
    evidence: unknown, now: string): PrepareRuntimeHostCapacityReleaseResult {
    const reservation = record.reservation!;
    const proof = { schemaVersion: 1, kind, intent: record.intent, reservation, source: record.source,
      dispatchedAt: record.dispatchedAt ?? null, createdAt: now, evidence };
    this.context.database.prepare(`INSERT INTO runtime_host_capacity_releases
      (intent_id,reservation_id,reservation_token,kind,proof_json,proof_digest,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(record.intent.intentId, reservation.reservationId, reservation.token, kind, JSON.stringify(proof), hash(proof), now);
    return { status: "prepared", release: this.getRelease(record.intent.intentId)! };
  }

  private validReservation(reservation: NonNullable<RuntimeHostCapacityIntentRecord["reservation"]>): boolean {
    return typeof reservation.reservationId === "string" && reservation.reservationId.trim().length > 0
      && typeof reservation.token === "string" && /^[0-9a-f]{64}$/u.test(reservation.token)
      && Number.isSafeInteger(reservation.policyRevision) && reservation.policyRevision >= 1
      && isTimestamp(reservation.reservedAt);
  }

  private mapIntent(row: Row): RuntimeHostCapacityIntentRecord {
    const source = sourceFromRow(row);
    if (row.workspace_id !== this.identity.workspaceId || row.workspace_key !== this.identity.workspaceKey
      || row.canonical_cwd !== this.identity.canonicalCwd || row.database_path !== this.identity.databasePath
      || row.database_file_identity !== this.identity.databaseFileIdentity
      || (source ? ["attempt", "workflow_start"].includes(String(row.owner_kind)) && row.owner_key !== ownerKey(source)
        : !["delegation_spawn", "approval_resume_pending", "user_input_continuation"].includes(String(row.owner_kind)) || typeof row.owner_key !== "string")) {
      throw new Error("runtime_host_capacity.intent_identity_changed");
    }
    const ownerKind = row.owner_kind;
    if (ownerKind !== "attempt" && ownerKind !== "workflow_start" && ownerKind !== "delegation_spawn"
      && ownerKind !== "approval_resume_pending" && ownerKind !== "user_input_continuation") {
      throw new Error("runtime_host_capacity.intent_identity_changed");
    }
    const intent = Object.freeze({ intentId: readString(row, "intent_id"), workspaceKey: this.identity.workspaceKey,
      canonicalCwd: this.identity.canonicalCwd, databasePath: this.identity.databasePath,
      databaseFileIdentity: this.identity.databaseFileIdentity,
      ownerKind,
      ownerKey: readString(row, "owner_key"), authorityDigest: readString(row, "authority_digest") });
    const record = Object.freeze({ intent, workspaceId: this.identity.workspaceId, source, createdAt: readString(row, "created_at"),
      ...(typeof row.reservation_id === "string" ? { reservation: Object.freeze({ reservationId: row.reservation_id,
        token: readString(row, "reservation_token"), intent, policyRevision: readNumber(row, "host_policy_revision"),
        reservedAt: readString(row, "reserved_at") }), dispatchToken: readString(row, "dispatch_token") } : {}),
      ...(typeof row.dispatched_at === "string" ? { dispatchedAt: row.dispatched_at } : {}),
      ...(typeof row.revoked_at === "string" ? { revokedAt: row.revoked_at } : {}),
      ...(source ? { source } : {}) });
    if (!isTimestamp(record.createdAt) || (record.reservation && (!this.validReservation(record.reservation)
      || record.reservation.reservedAt < record.createdAt))
      || (record.dispatchedAt && (!isTimestamp(record.dispatchedAt) || !record.reservation || record.dispatchedAt < record.reservation.reservedAt))
      || (record.revokedAt && (!isTimestamp(record.revokedAt) || !record.reservation || record.revokedAt < record.reservation.reservedAt)))
      throw new Error("runtime_host_capacity.intent_invalid");
    return record;
  }

  private readSource(source: HostOperationSource): Row | undefined {
    return this.context.database.prepare(`SELECT r.id AS run_id,r.status AS run_status,r.request_snapshot_json,r.task_snapshot_json,
      r.provider_snapshot_json,r.workflow_step_id,r.parent_run_id,r.continuation_reason,r.intervention_id,
      u.id AS work_unit_id,u.workspace_id,u.kind,u.owner_type,u.request_json,u.active_attempt_id,u.status AS unit_status,
      s.state AS step_state,
      a.id AS attempt_id,a.status AS attempt_status,a.started_at AS attempt_started_at,a.ended_at AS attempt_ended_at,
      a.abort_requested_at,a.attempt_number,COALESCE(a.effective_runner_id,a.runner_id) AS runner_id
      FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
      JOIN work_unit_attempts a ON a.work_unit_id=u.id
      LEFT JOIN delegation_steps s ON s.id=r.workflow_step_id
      WHERE r.id=? AND u.id=? AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=? AND u.workspace_id=?`)
      .get(...sourceFields.map(key => source[key]), this.identity.workspaceId);
  }

  private isFirstPiSource(row: Row): boolean {
    return row.runner_id === "pi" && row.attempt_number === 1 && row.workflow_step_id === null && row.parent_run_id === null
      && row.continuation_reason === null && row.intervention_id === null && row.owner_type !== "delegation_step"
      && ["task_run", "conversation_run", "teammate_direct_reply"].includes(String(row.kind));
  }

  private isWorkflowStartSource(row: Row): boolean {
    return (row.runner_id === "pi" || Boolean(this.nativeExecutionAdmission(row))) && row.attempt_number === 1
      && typeof row.workflow_step_id === "string"
      && row.workflow_step_id.length > 0 && row.parent_run_id === null && row.continuation_reason === null
      && row.intervention_id === null && row.owner_type !== "delegation_step"
      && ["task_run", "conversation_run", "teammate_direct_reply"].includes(String(row.kind));
  }

  private isDelegationSpawnSource(row: Row): boolean {
    return row.runner_id === "pi" && typeof row.attempt_number === "number" && row.attempt_number >= 1 && row.workflow_step_id !== null
      && row.parent_run_id !== null && row.owner_type === "delegation_step"
      && ["task_run", "conversation_run", "teammate_direct_reply"].includes(String(row.kind));
  }

  private isDispatchableSource(row: Row, ownerKind: RuntimeHostCapacityIntentRecord["intent"]["ownerKind"]): boolean {
    return ownerKind === "attempt" ? this.isOrdinaryExecutionSource(row, false)
      : ownerKind === "workflow_start" ? this.isWorkflowStartSource(row)
        : ownerKind === "delegation_spawn" ? this.isDelegationSpawnSource(row)
          : ownerKind === "user_input_continuation" ? this.isSupportedContinuationSource(row)
            && row.continuation_reason === "user_input_answer"
            : ownerKind === "approval_resume_pending" ? this.isSupportedContinuationSource(row)
              && Number(row.attempt_number) >= 2 : false;
  }

  private isPrestart(row: Row, ownerKind: RuntimeHostCapacityIntentRecord["intent"]["ownerKind"] = "attempt"): boolean {
    const resumingDelegation = ownerKind === "delegation_spawn" && row.step_state === "resuming";
    return row.attempt_status === "created" && row.attempt_started_at === null && row.attempt_ended_at === null
      && row.abort_requested_at === null && row.active_attempt_id === row.attempt_id
      && (ownerKind !== "attempt" || this.isOrdinaryExecutionSource(row))
      && (ownerKind === "approval_resume_pending" ? row.unit_status === "running" && row.run_status === "running" : resumingDelegation
        ? row.unit_status === "claimed" && row.run_status === "running"
        : ["queued", "claimed"].includes(String(row.unit_status))
          && (row.run_status === "queued" || ownerKind === "attempt" && row.run_status === "running" && this.hasOrdinaryContinuation(row)));
  }

  private hasOrdinaryContinuation(row: Row, pendingOnly = true): boolean {
    return !!this.context.database.prepare(`SELECT 1 FROM runner_continuations
      WHERE run_id=? AND work_unit_id=? AND target_attempt_id=?
        AND (?=0 OR state IN ('prepared','claimed')) AND origin<>'approval_resume' LIMIT 1`)
      .get(row.run_id, row.work_unit_id, row.attempt_id, pendingOnly ? 1 : 0);
  }

  private isOrdinaryPiSource(row: Row, pendingOnly = true): boolean {
    return row.runner_id === "pi" && row.owner_type !== "delegation_step"
      && ["task_run", "conversation_run", "teammate_direct_reply", "channel_ai_reply"].includes(String(row.kind))
      && (this.isFirstPiSource(row) || row.kind === "channel_ai_reply" && row.attempt_number === 1
        && row.workflow_step_id === null && row.parent_run_id === null && row.continuation_reason === null
        || this.hasOrdinaryContinuation(row, pendingOnly));
  }

  /** Native runs use the durable binding as their execution authority, not Pi's prepared input. */
  private nativeExecutionAdmission(row: Row): LocalExecutionAdmission | undefined {
    return this.nativeExecutionAdmissionForRequest(jsonObject(row.request_snapshot_json), row.runner_id);
  }

  private nativeExecutionAdmissionForRun(run: NonNullable<ReturnType<RunStore["getRun"]>>): LocalExecutionAdmission | undefined {
    const request = object(run.requestSnapshot);
    return this.nativeExecutionAdmissionForRequest(request, request?.runnerId);
  }

  private nativeExecutionAdmissionForRequest(request: Record<string, unknown> | undefined,
    runnerId: unknown): LocalExecutionAdmission | undefined {
    const binding = object(request?.executionBinding);
    const engineId = binding?.engineId, profileId = binding?.profileId, profileRevision = binding?.profileRevision;
    const tools = request?.tools;
    if (binding?.kind !== "native_profile" || typeof engineId !== "string" || !engineId.trim()
      || /[\x00-\x1f\x7f]/u.test(engineId) || typeof profileId !== "string" || !profileId.trim()
      || /[\x00-\x1f\x7f]/u.test(profileId) || typeof profileRevision !== "number"
      || !Number.isSafeInteger(profileRevision) || profileRevision < 1 || runnerId !== engineId
      || !Array.isArray(tools) || tools.some(tool => typeof tool !== "string" || !tool.trim() || /[\x00-\x1f\x7f]/u.test(tool))) {
      return undefined;
    }
    return Object.freeze({ providerKey: `native:${profileId}:${profileRevision}`, runnerKey: engineId,
      tools: Object.freeze([...tools]) });
  }

  private isFirstNativeSource(row: Row): boolean {
    return row.attempt_number === 1 && row.workflow_step_id === null && row.parent_run_id === null && row.continuation_reason === null
      && row.intervention_id === null && row.owner_type !== "delegation_step"
      && ["task_run", "conversation_run", "teammate_direct_reply", "channel_ai_reply"].includes(String(row.kind))
      && Boolean(this.nativeExecutionAdmission(row));
  }

  private isSupportedContinuationSource(row: Row): boolean {
    return row.runner_id === "pi" || Boolean(this.nativeExecutionAdmission(row));
  }

  private isNativeContinuationSource(row: Row): boolean {
    const reason = row.continuation_reason;
    if (!["manual_resume", "queue_followup", "interrupt_redirect"].includes(String(reason))
      || typeof row.parent_run_id !== "string" || !row.parent_run_id || row.parent_run_id === row.run_id
      || row.intervention_id !== null && typeof row.intervention_id !== "string") return false;
    const child = this.ports.getRun(String(row.run_id));
    const parent = this.ports.getRun(row.parent_run_id);
    if (!child || !parent || !child.threadId || child.threadId !== parent.threadId) return false;
    const childAdmission = this.nativeExecutionAdmission(row);
    const parentAdmission = this.nativeExecutionAdmissionForRun(parent);
    if (!childAdmission || !parentAdmission || childAdmission.runnerKey !== parentAdmission.runnerKey
      || childAdmission.providerKey !== parentAdmission.providerKey) return false;
    if (reason === "manual_resume") return row.intervention_id === null;
    if (typeof row.intervention_id !== "string" || !row.intervention_id) return false;
    const intervention = this.ports.getRunIntervention(row.intervention_id);
    if (!intervention || intervention.sourceRunId !== parent.id || intervention.mode !== reason
      || !["starting_continuation", "started"].includes(intervention.status)
      || intervention.sourceWorkUnitId !== undefined && intervention.sourceWorkUnitId !== parent.workUnitId
      || intervention.continuationRunId !== undefined && intervention.continuationRunId !== child.id
      || intervention.continuationWorkUnitId !== undefined && intervention.continuationWorkUnitId !== row.work_unit_id
      || intervention.status === "started" && intervention.continuationRunId !== child.id) return false;
    return true;
  }

  private isOrdinaryExecutionSource(row: Row, pendingOnly = true): boolean {
    return this.isOrdinaryPiSource(row, pendingOnly) || this.isFirstNativeSource(row)
      || this.isNativeContinuationSource(row);
  }

  private authorityDigest(row: Row, workflowStart = false): string {
    return hash([row.run_id, row.work_unit_id,
      workflowStart ? preparedExecutionIndependentSnapshot(row.request_snapshot_json) : row.request_snapshot_json,
      workflowStart ? preparedExecutionIndependentSnapshot(row.request_json) : row.request_json,
      row.task_snapshot_json, row.provider_snapshot_json, row.runner_id]);
  }

  private matchesAuthority(record: RuntimeHostCapacityIntentRecord, row: Row, now: string): boolean {
    if (record.intent.ownerKind === "approval_resume_pending" || record.intent.ownerKind === "user_input_continuation") {
      const authority = record.source && continuationCapacityAuthority(this.ports, this.identity.workspaceId, record, now, record.source);
      return !!authority && authority.ownerKey === record.intent.ownerKey && authority.authorityDigest === record.intent.authorityDigest;
    }
    if (record.intent.ownerKind === "delegation_spawn") {
      const admission = this.context.database.prepare(`SELECT a.expected_step_revision,a.runtime_instance_id,r.child_run_id,
        s.id AS step_id,run.work_unit_id FROM runtime_delegation_spawn_admissions a
        JOIN delegation_budget_reservations r ON r.id=a.reservation_id
        JOIN delegation_steps s ON s.id=r.delegation_step_id JOIN run_sessions run ON run.id=r.child_run_id
        WHERE a.admission_id=? AND a.host_intent_id=?`).get(record.intent.ownerKey, record.intent.intentId);
      if (admission) return record.intent.authorityDigest === hash([admission.child_run_id, admission.work_unit_id,
        admission.step_id, admission.expected_step_revision, admission.runtime_instance_id]);
    }
    return this.authorityDigest(row, record.intent.ownerKind === "workflow_start") === record.intent.authorityDigest;
  }

  private hasDispatchFacts(source: HostOperationSource): boolean {
    return Boolean(this.context.database.prepare(`SELECT 1 FROM host_attempt_completions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM host_operations WHERE attempt_id=?
      UNION ALL SELECT 1 FROM harness_tool_executions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM native_submissions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM runtime_run_queue WHERE attempt_id=? AND dispatched_at IS NOT NULL LIMIT 1`)
      .get(source.attemptId, source.attemptId, source.attemptId, source.attemptId, source.attemptId));
  }

  private hasActiveResources(source: HostOperationSource): boolean {
    return this.hasActiveAttemptSlots(source) || Boolean(this.context.database.prepare(
      "SELECT 1 FROM resource_leases WHERE attempt_id=? AND status='active' LIMIT 1").get(source.attemptId));
  }

  private hasActiveAttemptSlots(source: HostOperationSource): boolean {
    return Boolean(this.context.database.prepare(
      "SELECT 1 FROM runtime_semaphore_slots WHERE attempt_id=? AND status='active' LIMIT 1").get(source.attemptId));
  }

  private hasWorkflowStartPreparation(source: HostOperationSource, now: string): boolean {
    const run = this.context.database.prepare(`SELECT workflow_step_id FROM run_sessions
      WHERE id=? AND work_unit_id=? AND workflow_step_id IS NOT NULL AND status='queued'`)
      .get(source.runId, source.workUnitId);
    if (!run) return false;
    const preparingAdmission = this.context.database.prepare(`SELECT 1 FROM workflow_step_admissions
      WHERE workflow_step_id=? AND status='preparing' LIMIT 1`).get(run.workflow_step_id);
    const activeAttemptSlots = this.hasActiveAttemptSlots(source);
    return preparingAdmission ? !activeAttemptSlots : activeAttemptSlots && this.hasCompleteLocalAdmission(source, now, "attempt");
  }

  private hasPendingObligations(source: HostOperationSource): boolean {
    return Boolean(this.context.database.prepare(`SELECT 1 FROM user_input_requests
      WHERE (source_run_id=? OR source_attempt_id=?) AND (status='pending'
        OR wait_status IN ('waiting','resuming','blocked') OR EXISTS (SELECT 1 FROM user_input_answers a
          JOIN user_input_deliveries d ON d.answer_id=a.answer_id
          WHERE a.request_id=user_input_requests.request_id AND d.status IN ('pending','claimed','failed')))
      UNION ALL SELECT 1 FROM approval_requests WHERE run_id=? AND status='pending'
      UNION ALL SELECT 1 FROM delegation_budget_charges WHERE run_id=?
        AND state NOT IN ('measured','cancelled_before_dispatch')
      UNION ALL SELECT 1 FROM delegation_budget_reservations r
        JOIN delegation_steps s ON s.id=r.delegation_step_id
        WHERE r.state NOT IN ('settled','released')
          AND (r.root_run_id=? OR s.parent_run_id=? OR r.child_run_id=?) LIMIT 1`)
      .get(source.runId, source.attemptId, source.runId, source.runId,
        source.runId, source.runId, source.runId));
  }

  private hasCompleteLocalAdmission(source: HostOperationSource, now: string,
    ownerKind: RuntimeHostCapacityIntentRecord["intent"]["ownerKind"] = "attempt"): boolean {
    const sourceRow = this.readSource(source);
    if (ownerKind === "workflow_start" || ownerKind === "user_input_continuation"
      || ownerKind === "attempt" && sourceRow !== undefined && sourceRow.workflow_step_id !== null
      && this.isFirstNativeSource(sourceRow)) {
      const transferred = this.context.database.prepare(`SELECT admission.task_id FROM workflow_step_admissions AS admission
        JOIN run_sessions AS run ON run.workflow_step_id=admission.workflow_step_id
          AND run.id=? AND run.work_unit_id=?
        JOIN work_units AS unit ON unit.id=run.work_unit_id AND unit.linked_run_id=run.id
        WHERE admission.run_id=? AND admission.work_unit_id=? AND admission.attempt_id=?
          AND admission.runtime_instance_id=? AND admission.fencing_token=?
          AND admission.status='transferred' AND admission.transferred_at<=?`).get(source.runId, source.workUnitId, source.runId,
            source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken, now);
      if (transferred) return Boolean(this.context.database.prepare(`SELECT 1
        FROM workflow_step_admission_entries e JOIN runtime_semaphore_slots s ON s.id=e.slot_id
        WHERE e.task_id=? AND s.status='active' AND s.attempt_id=? LIMIT 1`).get(transferred.task_id, source.attemptId));
    }
    const run = this.ports.getRun(source.runId);
    if (!run) return false;
    const request = run.requestSnapshot as { runnerExecutionInput?: { runnerId?: string; input?: { tools?: unknown } }; tools?: unknown };
    const execution = request?.runnerExecutionInput, tools = execution?.input?.tools;
    const native = sourceRow ? this.nativeExecutionAdmission(sourceRow) : undefined;
    const localBash = ownerKind === "approval_resume_pending" && !native
      && (run.requestSnapshot as { harnessFeatureSnapshot?: { continuations?: string } })?.harnessFeatureSnapshot?.continuations !== "enforce";
    const effectiveTools = native?.tools ?? (Array.isArray(tools) ? tools : undefined);
    if (!localBash && !native && (execution?.runnerId !== "pi" || !effectiveTools
      || effectiveTools.some(tool => typeof tool !== "string"))) return false;
    if (!effectiveTools || effectiveTools.some(tool => typeof tool !== "string")) return false;
    const channel = run.channelId ? this.ports.getChannel(run.channelId) : undefined;
    if (run.channelId && (!channel || channel.status !== "active")) return false;
    const leases = new Map<string, string>();
    if (ownerKind !== "delegation_spawn" && this.ports.getTask(run.taskId)) leases.set("task", run.taskId);
    if (localBash || effectiveTools.some(tool => ["write", "edit", "bash"].includes(tool))) {
      const scope = channel?.runtimePolicy.writeLockScope ?? "boundPath";
      if (scope === "workspace" || scope === "channel" && !channel) leases.set("workspace", this.identity.workspaceId);
      else if (scope === "channel" && channel) leases.set("channel", channel.id);
      else {
        try { leases.set("bound_path", realpathSync.native(run.cwd)); }
        catch { return false; }
      }
    }
    const slots = new Map<string, string>([["provider", localBash ? "approval-resume-local-bash"
      : native?.providerKey ?? run.providerPresetId ?? `${run.providerName}:${run.providerModel}`],
      ["runner", native?.runnerKey ?? "pi"]]);
    if (channel && ownerKind !== "delegation_spawn") slots.set("channel_parallel", channel.id);
    const matches = (table: string, expected: ReadonlyMap<string, string>, ownerType: string, ownerId: string): boolean => {
      const rows = this.context.database.prepare(`SELECT * FROM ${table} WHERE attempt_id=? AND status='active'`).all(source.attemptId);
      return rows.length === expected.size && new Set(rows.map(row => row.resource_type)).size === expected.size
        && rows.every(row => row.workspace_id === this.identity.workspaceId && row.owner_type === ownerType && row.owner_id === ownerId
          && row.work_unit_id === source.workUnitId && row.runtime_instance_id === source.runtimeInstanceId
          && row.fencing_token === source.fencingToken && expected.get(String(row.resource_type)) === row.resource_key
          && typeof row.acquired_at === "string" && row.acquired_at <= now
          && typeof row.expires_at === "string" && row.expires_at > now);
    };
    return matches("resource_leases", leases, "run", source.runId)
      && matches("runtime_semaphore_slots", slots, "work_unit_attempt", source.attemptId);
  }

  private assertIdentity(): void {
    if (!isHostCapacityWorkspaceDatabaseConnectionCurrent(this.context.database, this.identity))
      throw new Error("runtime_host_capacity.database_identity_changed");
  }

  private write<T>(operation: () => T): T {
    this.assertIdentity();
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertIdentity();
      const result = withSqliteSnapshotParentTransaction(this.context.database, operation);
      const commit = typeof result === "boolean" ? result : (result as { status?: string }).status !== "changed";
      this.context.database.exec(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }
}
