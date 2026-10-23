import { isDeepStrictEqual, types } from "node:util";
import {
  captureRunProgressCheckpointLineage,
  RunProgressCheckpointError,
  type EffectiveRunPolicySnapshot,
  type DelegationInstructionModelMessage,
  type ReadRunProgressCheckpointForRecoveryResult,
  type RunProgressCheckpointBlockerCode,
  type RunProgressCheckpointWitness,
  type RunProgressContinuationBinding,
  type RunProgressDelegationBinding,
  type RunSession,
  type RunStore,
  type RuntimeAttemptFenceV1,
} from "@ling-stack/core";

export type OrdinaryRunProgressResult =
  | { readonly kind: "not_needed" }
  | { readonly kind: "committed"; readonly delegationInstructions?: {
      readonly insertAfterMessageCount: number;
      readonly messages: readonly DelegationInstructionModelMessage[];
    } }
  | { readonly kind: "unsupported"; readonly code: "checkpoint.effect_unjournaled" }
  | { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode };

export type RunSuspensionProgressResult =
  | { readonly kind: "sealed"; readonly witness: RunProgressCheckpointWitness }
  | { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode };

/** Read only the Core head authority, never a best-effort artifact or chat window. */
export function assessRunOrdinaryProgressRecovery(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly continuationBinding?: RunProgressContinuationBinding;
  readonly delegationBinding?: RunProgressDelegationBinding;
}): ReadRunProgressCheckpointForRecoveryResult {
  try {
    const current = input.store.getRun(input.run.id);
    if (!current) return blocked("checkpoint.lineage_mismatch");
    const { lineage } = captureRunProgressCheckpointLineage(input.store, current, input.policySnapshot);
    return input.store.readRunProgressCheckpointForRecovery({ runId: current.id, sourceFence: input.sourceFence,
      expectedLineage: lineage, continuationBinding: input.continuationBinding, delegationBinding: input.delegationBinding });
  } catch (error) {
    if (error instanceof RunProgressCheckpointError) return blocked(error.code);
    throw error;
  }
}

/**
 * Per physical Attempt producer. Its in-memory CAS expectation is not authority:
 * Core rechecks the actual head, frozen input, effects and owner in one transaction.
 */
export class OrdinaryRunProgressController {
  private witness: RunProgressCheckpointWitness | undefined;
  private recoveryProviderAdmitted = false;
  private readonly delegationBinding: RunProgressDelegationBinding | undefined;
  private rawModelView: readonly unknown[] | undefined;
  private committedModelView: readonly unknown[] | undefined;

  constructor(private readonly input: {
    readonly store: RunStore;
    readonly run: RunSession;
    readonly sourceFence: RuntimeAttemptFenceV1;
    readonly policySnapshot: EffectiveRunPolicySnapshot;
    readonly delegationBinding?: RunProgressDelegationBinding;
    readonly recovery?: {
      readonly witness: RunProgressCheckpointWitness;
      readonly modelView: readonly unknown[];
    } & ({ readonly continuationBinding: RunProgressContinuationBinding; readonly delegationBinding?: never }
      | { readonly delegationBinding: RunProgressDelegationBinding; readonly continuationBinding?: never });
  }) {
    this.witness = input.recovery?.witness;
    this.delegationBinding = input.delegationBinding ?? input.recovery?.delegationBinding;
    if (input.delegationBinding && input.recovery?.delegationBinding
      && !isDeepStrictEqual(input.delegationBinding, input.recovery.delegationBinding)) {
      throw new Error("Delegation progress bindings changed during controller construction.");
    }
    if (input.recovery) {
      this.rawModelView = structuredClone(input.recovery.modelView);
      this.committedModelView = structuredClone(input.recovery.modelView);
    }
  }

  /** Setup may await; a previously read recovery witness never grants dispatch forever. */
  verifyRecoveryBoundary(): OrdinaryRunProgressResult {
    const recovery = this.input.recovery;
    if (!recovery || this.recoveryProviderAdmitted) return { kind: "not_needed" };
    const assessment = assessRunOrdinaryProgressRecovery({ ...this.input,
      sourceFence: recovery.witness.sourceFence, continuationBinding: recovery.continuationBinding,
      delegationBinding: recovery.delegationBinding });
    if (assessment.kind === "blocked") return assessment;
    return assessment.kind === "verified" && isDeepStrictEqual(assessment.witness, recovery.witness)
      ? { kind: "not_needed" } : blocked("checkpoint.lineage_mismatch");
  }

  /** Seal a newly settled tool round before the next provider request. */
  beforeProviderBoundary(input: {
    readonly modelView: readonly unknown[] | undefined;
    readonly activeToolCallIds: readonly string[];
  }): OrdinaryRunProgressResult {
    return this.checkpointAtBoundary(input, false);
  }

  /**
   * A suspension must have an exact durable SDK view even without a new tool
   * round. This only seals progress: it grants neither stop nor resume authority.
   * Pending instructions stay queued because the Runner will not install them
   * after this boundary. Final/aborted assistant views remain Core-rejected.
   */
  sealSuspensionBoundary(input: {
    readonly modelView: readonly unknown[] | undefined;
    readonly activeToolCallIds: readonly string[];
  }): RunSuspensionProgressResult {
    if (!Array.isArray(input.modelView)) return blocked("checkpoint.snapshot_unavailable");
    const result = this.checkpointAtBoundary(input, true);
    if (result.kind === "blocked" || result.kind === "unsupported") return blocked(result.code);
    const expected = this.witness;
    if (!expected || !isDeepStrictEqual(expected.sourceFence, this.input.sourceFence)) {
      return blocked("checkpoint.lineage_mismatch");
    }
    // Reusing an unchanged head still revalidates the full Core payload,
    // permissions, owner, event watermark and effects. No in-memory safe latch.
    // This is the current live source, not a stopped source -> target handoff.
    // A delegation/continuation binding would require the previous Attempt to
    // be cancelled and would reject the very child whose boundary we sealed.
    const verified = assessRunOrdinaryProgressRecovery({ store: this.input.store, run: this.input.run,
      sourceFence: this.input.sourceFence, policySnapshot: this.input.policySnapshot });
    if (verified.kind === "blocked") return verified;
    if (verified.kind !== "verified" || !isDeepStrictEqual(verified.witness, expected)
      || !samePersistedSdkView(verified.modelView, this.projectCommittedView(input.modelView))) {
      return blocked("checkpoint.lineage_mismatch");
    }
    return { kind: "sealed", witness: structuredClone(verified.witness) };
  }

  private checkpointAtBoundary(input: {
    readonly modelView: readonly unknown[] | undefined;
    readonly activeToolCallIds: readonly string[];
  }, suspension: boolean): OrdinaryRunProgressResult {
    const { store, sourceFence } = this.input;
    if (input.activeToolCallIds.length > 0) return blocked("checkpoint.effect_unknown");
    const current = store.getRun(this.input.run.id);
    if (!current || !store.isCurrentRunExecutionOwner(current.id, sourceFence)) {
      return blocked("checkpoint.lineage_mismatch");
    }
    const events = this.readProgressAfter(current.id, this.witness?.sourceEventSeq ?? 0);
    if (!events) return blocked("checkpoint.effect_unknown");
    const newToolEnds = events.filter((event) => event.type === "tool_end");
    let instructionIds: readonly string[] = [];
    try {
      if (this.delegationBinding && !suspension) {
        instructionIds = store.listPendingDelegationInstructionIds({ runId: current.id, sourceFence,
          delegationBinding: this.delegationBinding, limit: 32 });
      }
    } catch (error) {
      if (error instanceof RunProgressCheckpointError) return producerDecision(blocked(error.code));
      throw error;
    }
    if (!suspension && newToolEnds.length === 0 && instructionIds.length === 0) {
      const recovery = this.verifyRecoveryBoundary();
      if (recovery.kind === "blocked") return recovery;
      // This marks the live Host gate only. The Runner independently checks the
      // installed view's exact first model projection before any provider I/O.
      this.recoveryProviderAdmitted = true;
      return { kind: "not_needed" };
    }
    if (!Array.isArray(input.modelView)) return blocked("checkpoint.snapshot_unavailable");
    if (suspension && events.length === 0 && this.witness
      && isDeepStrictEqual(this.witness.sourceFence, sourceFence)) {
      // No new canonical watermark means no second checkpoint identity can be
      // inserted. The suspension caller must verify this head and exact view.
      return { kind: "committed" };
    }
    try {
      const projected = this.projectCommittedView(input.modelView);
      if (!projected) return blocked("checkpoint.lineage_mismatch");
      const { lineage } = captureRunProgressCheckpointLineage(store, current, this.input.policySnapshot);
      const previous = this.witness;
      const result = store.commitRunProgressCheckpoint({ runId: current.id, sourceFence,
        expectedHead: { checkpointId: previous?.checkpointId ?? null, revision: previous?.headRevision ?? 0 },
        sourceEventSeq: events.at(-1)?.seq ?? previous?.sourceEventSeq ?? 0,
        expectedLineage: lineage, modelView: projected,
        ...(instructionIds.length ? {
          delegationBinding: this.delegationBinding!, delegationInstructionIds: instructionIds,
        } : {}),
        ...(previous && previous.sourceFence.attemptId !== sourceFence.attemptId
          ? { recoveryPredecessor: previous, delegationBinding: this.delegationBinding ?? this.input.recovery?.delegationBinding } : {}),
        now: new Date().toISOString() });
      if (result.kind === "blocked") return producerDecision(result);
      this.witness = { checkpointId: result.checkpoint.id, headRevision: result.headRevision,
        modelViewSha256: result.checkpoint.modelViewSha256, sourceEventSeq: result.checkpoint.sourceEventSeq,
        sourceFence: result.checkpoint.sourceFence, lineage: result.checkpoint.lineage };
      this.rawModelView = structuredClone(input.modelView);
      this.committedModelView = structuredClone(result.delegationInstructions?.length
        ? [...projected, ...result.delegationInstructions] : projected);
      this.recoveryProviderAdmitted = true;
      return { kind: "committed", ...(result.delegationInstructions?.length ? { delegationInstructions: {
        insertAfterMessageCount: input.modelView.length, messages: result.delegationInstructions,
      } } : {}) };
    } catch (error) {
      if (error instanceof RunProgressCheckpointError) return producerDecision(blocked(error.code));
      throw error;
    }
  }

  private projectCommittedView(current: readonly unknown[]): readonly unknown[] | undefined {
    if (!this.rawModelView || !this.committedModelView) return current;
    if (current.length < this.rawModelView.length
      || !isDeepStrictEqual(current.slice(0, this.rawModelView.length), this.rawModelView)) return undefined;
    return [...this.committedModelView, ...current.slice(this.rawModelView.length)];
  }

  private readProgressAfter(runId: string, after: number): ReturnType<RunStore["listEvents"]> | undefined {
    const events: ReturnType<RunStore["listEvents"]> = [];
    for (;;) {
      const page = this.input.store.listEvents(runId, { afterSeq: after, limit: 1000 });
      events.push(...page);
      if (events.length > 10_000) return undefined;
      if (page.length < 1000) return events;
      const next = page.at(-1)!.seq;
      if (next <= after) return undefined;
      after = next;
    }
  }
}

function blocked(code: RunProgressCheckpointBlockerCode): { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode } {
  return { kind: "blocked", code };
}

/** JSON storage omits optional object fields whose SDK value is undefined.
 * Compare that exact representation only; do not coerce arrays, numbers,
 * executable properties, custom objects or real non-undefined payload changes.
 */
export function samePersistedSdkView(saved: readonly unknown[], current: readonly unknown[] | undefined): boolean {
  const snapshot = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (types.isProxy(value)) throw new Error("non-data SDK view");
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error("non-data SDK array");
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("non-data SDK array");
        result.push(snapshot(descriptor.value));
      }
      return result;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("non-data SDK view");
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new Error("non-data SDK view");
      if (descriptor.value !== undefined) Object.defineProperty(result, key, {
        value: snapshot(descriptor.value), enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  try { return current !== undefined && isDeepStrictEqual(saved, snapshot(current)); }
  catch { return false; }
}

/** A known SDK passthrough is live-capable, not restart-capable. Never swallow unknown effects or commit failure. */
function producerDecision(result: { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode }): OrdinaryRunProgressResult {
  return result.code === "checkpoint.effect_unjournaled"
    ? { kind: "unsupported", code: result.code } : result;
}
