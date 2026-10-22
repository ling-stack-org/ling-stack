import { realpathSync } from "node:fs";
import type { RuntimeAttemptFenceV1 } from "@ling-stack/core";
import {
  delegationAuthority, delegationCapture, delegationFence, delegationId,
  DelegationWriteError,
  type DelegationAuthorityCapture, type DelegationChildReceipt, type DelegationExecutionAuthority,
  type DelegationUsageReceipt, type DelegationWriteAuthorityPorts,
} from "@ling-stack/core";

/**
 * These readers belong to the execution composition root, not a route/model.
 * In particular, usage/completion references must be backed by the original
 * adapter/journal observation, never a user-supplied DTO or authenticated=true.
 */
export interface DelegationHostAuthoritySource {
  readonly readRootAdmissionScope: (runId: string, fence: RuntimeAttemptFenceV1) => DelegationAuthorityCapture;
  readonly readChildLaunchScope: (runId: string, fence: RuntimeAttemptFenceV1, participantId: string | undefined) => DelegationAuthorityCapture;
  readonly readCurrentExecutionAuthority: (runId: string, fence: RuntimeAttemptFenceV1) => DelegationExecutionAuthority;
  readonly readProviderUsageObservation: (reference: unknown) => DelegationUsageReceipt;
  readonly readChildCompletionObservation: (reference: unknown) => DelegationChildReceipt;
  /** A root or child model call after its own actual Provider preflight. */
  readonly readModelInvocationScope?: (runId: string, fence: RuntimeAttemptFenceV1) => DelegationAuthorityCapture;
}

/** Only this local Host instance can authenticate its issued capture/receipt objects. */
export function createDelegationHostAuthority(source: DelegationHostAuthoritySource): {
  readonly readers: DelegationWriteAuthorityPorts;
  readonly captureRoot: (runId: string, fence: RuntimeAttemptFenceV1) => object;
  readonly captureChild: (runId: string, fence: RuntimeAttemptFenceV1, participantId?: string) => object;
  readonly captureModelInvocation: (runId: string, fence: RuntimeAttemptFenceV1) => object;
  readonly captureUsageReceipt: (observation: unknown) => object;
  readonly captureChildReceipt: (observation: unknown) => object;
} {
  const captures = new WeakMap<object, DelegationAuthorityCapture>();
  const usages = new WeakMap<object, DelegationUsageReceipt>();
  const completions = new WeakMap<object, DelegationChildReceipt>();
  function issue<T>(map: WeakMap<object, T>, value: T): object {
    const reference = Object.freeze(Object.create(null) as object);
    map.set(reference, value);
    return reference;
  }
  function read<T>(map: WeakMap<object, T>, value: unknown): T {
    if (typeof value !== "object" || !value || !map.has(value)) throw new DelegationWriteError("delegation.authority_invalid");
    return map.get(value)!;
  }
  function canonical(value: DelegationExecutionAuthority): DelegationExecutionAuthority {
    const authority = delegationAuthority(value);
    // Check the Host assertion, do not silently rewrite a historical identity.
    for (const root of authority.workspaceRoots) {
      if (realpathSync.native(root.path) !== root.path) throw new DelegationWriteError("delegation.authority_invalid");
    }
    return authority;
  }
  function capture(value: DelegationAuthorityCapture, runId: string, fence: RuntimeAttemptFenceV1): object {
    const snapshot = delegationCapture(value);
    if (snapshot.runId !== runId || Object.keys(fence).some(key => fence[key as keyof RuntimeAttemptFenceV1] !== snapshot.sourceFence[key as keyof RuntimeAttemptFenceV1])) {
      throw new DelegationWriteError("delegation.authority_invalid");
    }
    canonical(snapshot.authority);
    return issue(captures, snapshot);
  }
  return Object.freeze({
    readers: Object.freeze({
      readCapture: (value: unknown) => read(captures, value),
      readCurrentAuthority: (runId: string, rawFence: RuntimeAttemptFenceV1) => canonical(source.readCurrentExecutionAuthority(delegationId(runId), delegationFence(rawFence))),
      readUsageReceipt: (value: unknown) => read(usages, value),
      readChildReceipt: (value: unknown) => read(completions, value),
    }),
    captureRoot: (rawRunId: string, rawFence: RuntimeAttemptFenceV1) => {
      const runId = delegationId(rawRunId), fence = delegationFence(rawFence);
      return capture(source.readRootAdmissionScope(runId, fence), runId, fence);
    },
    captureChild: (rawRunId: string, rawFence: RuntimeAttemptFenceV1, rawParticipantId?: string) => {
      const runId = delegationId(rawRunId), fence = delegationFence(rawFence);
      const participantId = rawParticipantId === undefined ? undefined : delegationId(rawParticipantId);
      const value = source.readChildLaunchScope(runId, fence, participantId);
      if (value.authority.participantId !== participantId) throw new DelegationWriteError("delegation.authority_invalid");
      return capture(value, runId, fence);
    },
    captureModelInvocation: (rawRunId: string, rawFence: RuntimeAttemptFenceV1) => {
      if (!source.readModelInvocationScope) throw new DelegationWriteError("delegation.authority_invalid");
      const runId = delegationId(rawRunId), fence = delegationFence(rawFence);
      return capture(source.readModelInvocationScope(runId, fence), runId, fence);
    },
    captureUsageReceipt: (reference: unknown) => {
      const value = source.readProviderUsageObservation(reference);
      // Capture by value so a later mutable adapter object cannot change a receipt.
      return issue(usages, Object.freeze(structuredClone(value)));
    },
    captureChildReceipt: (reference: unknown) => {
      const value = source.readChildCompletionObservation(reference);
      return issue(completions, Object.freeze(structuredClone(value)));
    },
  });
}
