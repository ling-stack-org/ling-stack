import { isDeepStrictEqual } from "node:util";
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
      if (this.delegationBinding) {
        instructionIds = store.listPendingDelegationInstructionIds({ runId: current.id, sourceFence,
          delegationBinding: this.delegationBinding, limit: 32 });
      }
    } catch (error) {
      if (error instanceof RunProgressCheckpointError) return producerDecision(blocked(error.code));
      throw error;
    }
    if (newToolEnds.length === 0 && instructionIds.length === 0) {
      const recovery = this.verifyRecoveryBoundary();
      if (recovery.kind === "blocked") return recovery;
      // This marks the live Host gate only. The Runner independently checks the
      // installed view's exact first model projection before any provider I/O.
      this.recoveryProviderAdmitted = true;
      return { kind: "not_needed" };
    }
    if (!Array.isArray(input.modelView)) return blocked("checkpoint.snapshot_unavailable");
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

/** A known SDK passthrough is live-capable, not restart-capable. Never swallow unknown effects or commit failure. */
function producerDecision(result: { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode }): OrdinaryRunProgressResult {
  return result.code === "checkpoint.effect_unjournaled"
    ? { kind: "unsupported", code: result.code } : result;
}
