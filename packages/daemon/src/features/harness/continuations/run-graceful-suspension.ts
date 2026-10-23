import { isDeepStrictEqual } from "node:util";
import type { RunCompactionCheckpointBlockerCode } from "@ling-stack/contracts";
import {
  captureRunProgressCheckpointLineage,
  RunProgressCheckpointError,
  type EffectiveRunPolicySnapshot,
  type RequestRunSuspensionInput,
  type RunProgressCheckpointBlockerCode,
  type RunSession,
  type RunStore,
  type RunSuspensionCause,
  type RunSuspensionRecord,
  type RunSuspensionStopInput,
  type RunSuspensionStopRecord,
  type RunSuspensionSettlementWitness,
  type RunSuspensionWitness,
  type RuntimeAttemptFenceV1,
  type SealRunSuspensionInput,
} from "@ling-stack/core";
import { PiRunnerSuspended, type PiRunnerRuntimeSuspensionDirective } from "@ling-stack/runner-pi";
import type { OrdinaryRunProgressController } from "./run-ordinary-progress.js";
import type { CompactedRunSuspensionProgressResult } from "./run-compaction-suspension.js";

/** Constructor-private Host capability, never a public Store or model surface. */
export interface RunGracefulSuspensionLifecycle {
  readonly requestRunSuspension: (input: RequestRunSuspensionInput) => RunSuspensionRecord;
  readonly sealRunSuspension: (input: SealRunSuspensionInput) => RunSuspensionRecord;
  readonly beginRunSuspensionStop: (input: RunSuspensionStopInput) => RunSuspensionStopRecord;
  readonly commitRunSuspensionStopped: (input: RunSuspensionStopInput) => RunSuspensionStopRecord;
  readonly getRunSuspensionStop: (id: string) => RunSuspensionStopRecord | undefined;
}

export type RunGracefulSuspensionBlockerCode = RunProgressCheckpointBlockerCode | RunCompactionCheckpointBlockerCode
  | "suspension.source_not_started" | "suspension.source_stale" | "suspension.request_conflict"
  | "suspension.request_mismatch" | "suspension.witness_mismatch" | "suspension.boundary_changed"
  | "suspension.already_sealed" | "suspension.boundary_unavailable" | "suspension.result_not_suspended"
  | "suspension.directive_mismatch" | "suspension.sdk_stop_unobserved" | "suspension.stop_unverified";

/** A pending intent cannot fall through to an ordinary success/failure result. */
export class RunGracefulSuspensionBlocked extends Error {
  constructor(readonly code: RunGracefulSuspensionBlockerCode) {
    super(code);
    this.name = "RunGracefulSuspensionBlocked";
  }
}

type BoundaryInput = {
  readonly boundary: "before_agent_start" | "before_provider_request" | "tool_call" | "task_settled";
  readonly modelView?: readonly unknown[];
  readonly activeToolCallIds: readonly string[];
};

/**
 * One original physical source only. Request/seal/SDK-stop are separate facts;
 * this object never awaits its own lifetime or supplies a made-up drain flag.
 * Ordinary and compacted views retain their distinct Core checkpoint authority.
 * Final assistant settlement is not inferred from either model-view payload.
 */
export class RunGracefulSuspensionController {
  private readonly requested = new AbortController();
  private requestRecord: RunSuspensionRecord | undefined;
  private sealedRecord: RunSuspensionRecord | undefined;
  private directive: PiRunnerRuntimeSuspensionDirective | undefined;
  private boundaryFlight: Promise<PiRunnerRuntimeSuspensionDirective> | undefined;
  private boundaryInput: BoundaryInput | undefined;
  private beginRecord: RunSuspensionStopRecord | undefined;
  private sdkStopObservation: {
    readonly request: PiRunnerRuntimeSuspensionDirective;
    readonly sdkStoppedAt: string;
  } | undefined;
  private readonly sourceFence: RuntimeAttemptFenceV1;

  constructor(private readonly input: {
    readonly store: RunStore;
    readonly run: RunSession;
    readonly sourceFence: RuntimeAttemptFenceV1;
    readonly policySnapshot: EffectiveRunPolicySnapshot;
    readonly progress: Pick<OrdinaryRunProgressController, "sealSuspensionBoundary">;
    readonly compactionProgress?: (input: Pick<BoundaryInput, "modelView" | "activeToolCallIds">) => CompactedRunSuspensionProgressResult;
    readonly settlementProgress?: (input: Pick<BoundaryInput, "modelView" | "activeToolCallIds">) =>
      { readonly kind: "sealed"; readonly witness: RunSuspensionSettlementWitness }
      | { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode };
    readonly lifecycle: RunGracefulSuspensionLifecycle;
    readonly assertCurrent: () => void;
    /** Explicit cancellation/revocation checks, allowing Core's expected cancelling state. */
    readonly assertCleanupCurrent: () => void;
    readonly now: () => string;
    /** Ordering barrier for descendants only; not their durable stop proof. */
    readonly awaitDescendantsReady: () => Promise<void>;
  }) {
    this.sourceFence = Object.freeze(structuredClone(input.sourceFence));
  }

  hasPendingRequest(): boolean { return this.requestRecord !== undefined; }
  /** Cancels only a Host fan-in observer, never SDK execution or a child. */
  get requestSignal(): AbortSignal { return this.requested.signal; }

  /** Synchronous: the first caller returns only after the exact intent is durable. */
  request(cause: RunSuspensionCause): RunSuspensionRecord {
    this.input.assertCurrent();
    const current = this.liveSource();
    let lineage;
    try {
      ({ lineage } = captureRunProgressCheckpointLineage(this.input.store, current, this.input.policySnapshot));
    } catch (error) {
      if (error instanceof RunProgressCheckpointError) throw new RunGracefulSuspensionBlocked(error.code);
      throw error;
    }
    const previous = this.requestRecord;
    if (previous) {
      if (previous.request.cause !== cause) fail("suspension.request_conflict");
      if (!isDeepStrictEqual(previous.request.lineage, lineage)) fail("suspension.witness_mismatch");
      return structuredClone(previous);
    }
    const record = this.input.lifecycle.requestRunSuspension({ runId: current.id, sourceFence: this.sourceFence,
      cause, expectedLineage: lineage, now: this.input.now() });
    if (record.request.runId !== current.id || record.request.cause !== cause
      || !isDeepStrictEqual(record.request.sourceFence, this.sourceFence)
      || !isDeepStrictEqual(record.request.lineage, lineage)) fail("suspension.request_mismatch");
    this.requestRecord = structuredClone(record);
    this.requested.abort(new Error("runtime_graceful_suspension_requested"));
    return structuredClone(record);
  }

  beforeBoundary(input: BoundaryInput & { readonly boundary: Exclude<BoundaryInput["boundary"], "task_settled"> }): Promise<PiRunnerRuntimeSuspensionDirective | undefined> {
    if (!this.requestRecord) return Promise.resolve(undefined);
    if (this.beginRecord) this.input.assertCleanupCurrent();
    else this.input.assertCurrent();
    // In-flight rounds must be allowed to settle. No unproven tool/agent-start
    // view is sealed, and assertSuspensionHandled rejects a terminal fallback.
    if (input.boundary !== "before_provider_request") {
      if (this.sealedRecord) fail("suspension.already_sealed");
      return Promise.resolve(undefined);
    }
    return this.enterBoundary(input);
  }

  /** Called only within the original SDK's non-aborted agent-settled window. */
  beforeSettledBoundary(input: Pick<BoundaryInput, "modelView" | "activeToolCallIds">): Promise<PiRunnerRuntimeSuspensionDirective | undefined> {
    if (!this.requestRecord) return Promise.resolve(undefined);
    if (this.beginRecord) this.input.assertCleanupCurrent();
    else this.input.assertCurrent();
    return this.enterBoundary({ ...input, boundary: "task_settled" });
  }

  private enterBoundary(input: BoundaryInput): Promise<PiRunnerRuntimeSuspensionDirective> {
    const captured = structuredClone(input);
    if (this.boundaryFlight) {
      if (!isDeepStrictEqual(this.boundaryInput, captured)) fail("suspension.boundary_changed");
      return this.boundaryFlight;
    }
    this.boundaryInput = captured;
    // Install single-flight before invoking private ports, including reentrant ones.
    this.boundaryFlight = Promise.resolve().then(() => this.sealAndBegin(captured));
    return this.boundaryFlight;
  }

  /** Must run before every ordinary Runner-result/terminal fallback. */
  assertSuspensionHandled(): void {
    if (!this.requestRecord) return;
    if (this.beginRecord) this.input.assertCleanupCurrent();
    else this.input.assertCurrent();
    fail(this.sealedRecord ? "suspension.result_not_suspended" : "suspension.boundary_unavailable");
  }

  /** Only the genuine Runner control error with this exact captured directive is accepted. */
  observeSuspended(error: unknown): void {
    this.input.assertCleanupCurrent();
    if (!this.directive || !this.beginRecord || !(error instanceof PiRunnerSuspended)
      || Object.getPrototypeOf(error) !== PiRunnerSuspended.prototype
      || !isDeepStrictEqual(error.request, this.directive)
      || !isTimestamp(error.sdkStoppedAt)
      || error.sdkStoppedAt < this.beginRecord.begin.begunAt) fail("suspension.directive_mismatch");
    this.sdkStopObservation ??= Object.freeze({ request: this.directive, sdkStoppedAt: error.sdkStoppedAt });
  }

  /** Root calls this only after its original executor lifetime/durable work settles. */
  commitStopped(): RunSuspensionStopRecord {
    this.input.assertCleanupCurrent();
    if (!this.sdkStopObservation || !this.beginRecord || !this.sealedRecord) fail("suspension.sdk_stop_unobserved");
    // Core independently rereads actual completion, effects, audit and descendant
    // facts. Neither the SDK error nor Root's ordering promise is drain authority.
    const committed = this.input.lifecycle.commitRunSuspensionStopped(this.stopInput());
    const actual = this.input.lifecycle.getRunSuspensionStop(this.sealedRecord.id);
    if (!actual || !isDeepStrictEqual(committed, actual)) fail("suspension.stop_unverified");
    this.verifyStop(actual, "stopped");
    return structuredClone(actual);
  }

  private async sealAndBegin(input: BoundaryInput): Promise<PiRunnerRuntimeSuspensionDirective> {
    this.input.assertCurrent();
    this.liveSource();
    const witness = this.sealProgress(input);
    const sealed = this.input.lifecycle.sealRunSuspension({ suspensionId: this.requestRecord!.id,
      sourceFence: this.sourceFence, witness, now: this.input.now() });
    this.verifySeal(sealed, witness);
    this.sealedRecord = structuredClone(sealed);
    await this.input.awaitDescendantsReady();
    this.input.assertCurrent();
    this.liveSource();
    const actualWitness = this.sealProgress(input);
    if (!isDeepStrictEqual(witness, actualWitness)) fail("suspension.witness_mismatch");
    // Repeat the authoritative seal verification after the asynchronous tree
    // barrier; the first receipt is not a permanent live-source permission.
    const actualSeal = this.input.lifecycle.sealRunSuspension({ suspensionId: sealed.id,
      sourceFence: this.sourceFence, witness: actualWitness, now: this.input.now() });
    this.verifySeal(actualSeal, actualWitness);
    if (!isDeepStrictEqual(actualSeal, sealed)) fail("suspension.witness_mismatch");
    const begun = this.input.lifecycle.beginRunSuspensionStop(this.stopInput());
    this.verifyStop(begun, "stopping");
    this.beginRecord = structuredClone(begun);
    this.directive = Object.freeze({ schemaVersion: 1, kind: "runtime_suspension", runId: this.input.run.id,
      attemptId: this.sourceFence.attemptId, suspensionId: sealed.id,
      checkpointId: witness.kind === "settlement" ? witness.settlement.id : witness.checkpoint.checkpointId,
      checkpointSha256: witness.kind === "settlement" ? witness.settlement.modelViewSha256
        : witness.kind === "ordinary" ? witness.checkpoint.modelViewSha256 : witness.checkpoint.summaryContentSha256 });
    return this.directive;
  }

  private liveSource(): RunSession {
    const { store } = this.input;
    const run = store.getRun(this.input.run.id);
    const unit = store.getWorkUnit(this.sourceFence.workUnitId);
    const attempt = store.getWorkUnitAttempt(this.sourceFence.attemptId);
    if (!run || !unit || !attempt || run.workUnitId !== this.sourceFence.workUnitId
      || unit.linkedRunId !== run.id || unit.activeAttemptId !== attempt.id
      || attempt.workUnitId !== this.sourceFence.workUnitId
      || attempt.runtimeInstanceId !== this.sourceFence.runtimeInstanceId
      || attempt.fencingToken !== this.sourceFence.fencingToken || attempt.abortRequestedAt
      || run.endedAt || attempt.endedAt) fail("suspension.source_stale");
    if (run.status === "queued" || attempt.status === "created") fail("suspension.source_not_started");
    if (run.status !== "running" || unit.status !== "running" || attempt.status !== "started"
      || !store.isCurrentRunExecutionOwner(run.id, this.sourceFence)) fail("suspension.source_stale");
    return run;
  }

  private sealProgress(input: BoundaryInput): RunSuspensionWitness {
    const final = input.boundary === "task_settled" ? this.input.settlementProgress?.(input) : undefined;
    if (input.boundary === "task_settled" && !final) fail("suspension.boundary_unavailable");
    if (final?.kind === "blocked") fail(final.code);
    const compacted = final ? undefined : this.input.compactionProgress?.(input);
    if (compacted?.kind === "blocked") fail(compacted.code);
    let witness: RunSuspensionWitness;
    if (final?.kind === "sealed") witness = final.witness;
    else if (compacted?.kind === "sealed") witness = compacted.witness;
    else {
      const result = this.input.progress.sealSuspensionBoundary({ modelView: input.modelView,
        activeToolCallIds: input.activeToolCallIds });
      if (result.kind === "blocked") fail(result.code);
      if (result.kind !== "sealed") fail("checkpoint.snapshot_unavailable");
      witness = { kind: "ordinary", checkpoint: result.witness };
    }
    const request = this.requestRecord!.request;
    const boundary = witness.kind === "settlement" ? witness.settlement : witness.checkpoint;
    const watermark = witness.kind === "ordinary" ? witness.checkpoint.sourceEventSeq
      : witness.kind === "settlement" ? witness.settlement.boundaryEventSeq : witness.checkpoint.boundaryEventSeq;
    if (!isDeepStrictEqual(boundary.sourceFence, this.sourceFence)
      || !isDeepStrictEqual(boundary.lineage, request.lineage)
      || watermark < request.requestedEventSeq) fail("suspension.witness_mismatch");
    return structuredClone(witness);
  }

  private verifySeal(record: RunSuspensionRecord, witness: RunSuspensionWitness): void {
    const expected = this.requestRecord!;
    if (record.id !== expected.id || record.state !== "sealed" || !record.seal
      || !isDigest(record.sealDigest) || !record.sealArtifactId
      || record.requestDigest !== expected.requestDigest || !isDeepStrictEqual(record.request, expected.request)
      || record.seal.suspensionId !== expected.id || record.seal.runId !== this.input.run.id
      || record.seal.requestDigest !== expected.requestDigest
      || !isDeepStrictEqual(record.seal.sourceFence, this.sourceFence)
      || !isDeepStrictEqual(record.seal.witness, witness)) fail("suspension.witness_mismatch");
  }

  private stopInput(): RunSuspensionStopInput {
    return { suspensionId: this.sealedRecord!.id, sourceFence: this.sourceFence, now: this.input.now() };
  }

  private verifyStop(record: RunSuspensionStopRecord, state: "stopping" | "stopped"): void {
    const sealed = this.sealedRecord!, begin = record.begin;
    if (record.suspensionId !== sealed.id || record.state !== state || !record.beginArtifactId
      || !isDigest(record.beginDigest) || begin.schemaVersion !== 1 || begin.kind !== "run.suspension_stop_begin.v1"
      || begin.suspensionId !== sealed.id || begin.runId !== this.input.run.id
      || begin.sealDigest !== sealed.sealDigest || !isDigest(begin.modelAdmissionDigest) || !isDigest(begin.canonicalEventDigest)
      || !isDeepStrictEqual(begin.sourceFence, this.sourceFence)
      || this.beginRecord && (record.beginDigest !== this.beginRecord.beginDigest
        || !isDeepStrictEqual(begin, this.beginRecord.begin))) fail("suspension.stop_unverified");
    if (state === "stopped") {
      const receipt = record.receipt;
      if (!record.receiptArtifactId || !isDigest(record.receiptDigest) || !receipt
        || receipt.schemaVersion !== 1 || receipt.kind !== "run.suspension_stopped.v1"
        || receipt.suspensionId !== sealed.id || receipt.runId !== this.input.run.id
        || receipt.beginDigest !== record.beginDigest || receipt.sealDigest !== sealed.sealDigest
        || !isDeepStrictEqual(receipt.sourceFence, this.sourceFence)) fail("suspension.stop_unverified");
    }
  }
}

function fail(code: RunGracefulSuspensionBlockerCode): never { throw new RunGracefulSuspensionBlocked(code); }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
