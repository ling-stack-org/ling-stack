import assert from "node:assert/strict";
import { resolveTeammateDirectRunOwner } from "../../dist/features/teammates/direct-run-owner.js";

export const DIRECT_RUNTIME_FIXTURE_FENCE = Object.freeze({ workUnitId: "fixture-unit", attemptId: "fixture-attempt",
  runtimeInstanceId: "fixture-runtime", fencingToken: "fixture-fence" });

/**
 * Unit-test ports for the typed Core runtime capability. This does not implement
 * SQLite admission: real multi-connection/CAS and recovery tests cover that layer.
 * Re-read native ownership on every observation, never grant an old sink a new fence.
 */
export function attachDirectRuntimeProjectionPorts(store, { readMessage, writeMessage, state }) {
  const fence = DIRECT_RUNTIME_FIXTURE_FENCE;
  let revision = 0;
  store.getTeammateDirectMessageRuntimeObservation = scope => {
    const message = readMessage();
    if (!message || message.id !== scope.messageId) return undefined;
    const runId = scope.runId ?? message.linkedRunId;
    const owner = runId ? resolveTeammateDirectRunOwner(store, runId, {
      teammateId: scope.teammateId, directThreadId: scope.threadId, replyMessageId: message.id,
    }) : undefined;
    return { scope, message: structuredClone(message), fingerprint: String(revision), lastRunEventSeq: 0,
      state: owner ? state?.(message) ?? { kind: "active" } : { kind: "indeterminate", reason: "owner_mismatch" },
      run: owner?.run, turn: owner?.turn,
      workUnit: { id: fence.workUnitId },
      attempt: { id: fence.attemptId, workUnitId: fence.workUnitId,
        runtimeInstanceId: fence.runtimeInstanceId, fencingToken: fence.fencingToken } };
  };
  store.commitTeammateDirectMessageRuntime = ({ expected, operation }) => {
    const current = store.getTeammateDirectMessageRuntimeObservation(expected.scope);
    if (!current || current.fingerprint !== expected.fingerprint
      || JSON.stringify(current.message) !== JSON.stringify(expected.message)) return { kind: "stale" };
    if (current.state.kind === "indeterminate") return { kind: "owner_mismatch" };
    if (operation.kind === "execution") {
      assert.deepEqual(operation.fence, fence, "live callbacks retain their original full capability");
      if (current.state.kind !== "active" || current.message.status !== "pending") return { kind: "invalid_proof" };
    }
    revision++;
    return { kind: "applied", message: writeMessage(operation.patch) };
  };
  return store;
}
