import { useEffect, useRef, useState } from "react";
import { cancelTeammateDirectReply, getWorkUnit } from "../../api.js";
import type { WorkUnitDetailResponse } from "../../types.js";
import { isWorkUnitStopSettled } from "../../lib/run-stop-settlement.js";
import { privateStopLookupJournal, type PrivateStopLookupRecord, type PrivateStopLookupScope } from "./private-stop-lookup-journal.js";
import type { TeammateWorkspaceRequestOwner, TeammateWorkspaceRequestToken } from "./useTeammateWorkspaceRequestOwner.js";

interface PrivateStopOperation {
  readonly key: string;
  readonly revision: number;
  readonly token: TeammateWorkspaceRequestToken;
  readonly scope: PrivateStopLookupScope;
  record?: PrivateStopLookupRecord;
  lookupStored?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export function useTeammateDirectStopController(options: {
  readonly cwd: string;
  readonly teammateId: string;
  readonly threadId?: string;
  readonly busy: boolean;
  readonly activeWorkUnitId?: string;
  readonly owner: TeammateWorkspaceRequestOwner;
  readonly noActiveReplyMessage: string;
  readonly pendingMessage: string;
  readonly resolveReply: (token: TeammateWorkspaceRequestToken) => Promise<{
    readonly status: "current" | "stale";
    readonly activeReply?: { readonly workUnitId: string; readonly messageId?: string };
  }>;
  readonly refreshRuntime: () => Promise<unknown>;
}): { readonly stopping: boolean; readonly stop: () => Promise<void> } {
  const latest = useRef(options);
  latest.current = options;
  const identity = JSON.stringify([options.cwd.trim(), options.teammateId, options.threadId ?? ""]);
  const scopeRef = useRef({ identity, revision: 0 });
  if (scopeRef.current.identity !== identity) scopeRef.current = { identity, revision: scopeRef.current.revision + 1 };
  const operations = useRef(new Map<string, PrivateStopOperation>());
  const [pending, setPending] = useState<readonly PrivateStopOperation[]>([]);

  useEffect(() => {
    const owned = operations.current;
    setPending([]);
    return () => {
      for (const operation of owned.values()) clearTimeout(operation.timer);
      owned.clear();
    };
  }, [identity]);

  useEffect(() => {
    if (!options.threadId) return;
    const scope = { cwd: options.cwd.trim(), teammateId: options.teammateId, threadId: options.threadId };
    try {
      for (const record of privateStopLookupJournal.read(scope)) {
        const key = operationKey(scope, record);
        if ([...operations.current.values()].some(operation => operation.record?.workUnitId === record.workUnitId
          && operation.record.attemptId === record.attemptId)) continue;
        const token = latest.current.owner.beginWorkspaceAction("stop");
        const operation: PrivateStopOperation = { key, scope, record, token, lookupStored: true, revision: scopeRef.current.revision };
        operations.current.set(key, operation);
        void reconcile(operation);
      }
      updatePending();
    } catch {
      latest.current.owner.reportImmediate("stop", latest.current.pendingMessage);
    }
    // Recovery only reads original WorkUnit facts. It must never call the mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, options.threadId]);

  function updatePending(): void {
    setPending([...operations.current.values()]);
  }

  function isCurrent(operation: PrivateStopOperation): boolean {
    return operations.current.get(operation.key) === operation && scopeRef.current.revision === operation.revision;
  }

  function finish(operation: PrivateStopOperation): void {
    if (!isCurrent(operation)) return;
    if (operation.lookupStored && operation.record) privateStopLookupJournal.forget(operation.scope, operation.record);
    clearTimeout(operation.timer);
    operations.current.delete(operation.key);
    updatePending();
  }

  function validateDetail(operation: PrivateStopOperation, detail: WorkUnitDetailResponse): void {
    const unit = detail.workUnit;
    const record = operation.record;
    if (!record || detail.cwd.trim() !== operation.scope.cwd || unit.id !== record.workUnitId
      || unit.kind !== "teammate_direct_reply" || unit.teammateId !== operation.scope.teammateId
      || unit.linkedMessageId !== record.messageId
      || (record.linkedRunId && unit.linkedRunId !== record.linkedRunId)
      || detail.attempts.some(attempt => attempt.workUnitId !== unit.id)
      || (unit.linkedRunId && detail.run?.id !== unit.linkedRunId)) {
      throw new Error(latest.current.pendingMessage);
    }
  }

  async function reconcile(operation: PrivateStopOperation, rejected = false): Promise<void> {
    if (!isCurrent(operation) || !operation.record) return;
    try {
      const detail = await getWorkUnit(operation.scope.cwd, operation.record.workUnitId);
      if (!isCurrent(operation)) return;
      validateDetail(operation, detail);
      const terminal = ["cancelled", "failed", "succeeded"].includes(detail.workUnit.status);
      if (!isWorkUnitStopSettled(detail, operation.record.attemptId)) {
        if (rejected && !terminal && detail.workUnit.status !== "cancelling") finish(operation);
        return;
      }
      // Refresh the selected owner's snapshot, never install the POST's captured message.
      await latest.current.refreshRuntime();
      if (!isCurrent(operation)) return;
      latest.current.owner.clearError(operation.token);
      finish(operation);
    } catch (error) {
      if (isCurrent(operation)) latest.current.owner.reportError(operation.token, error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent(operation)) operation.timer = setTimeout(() => { void reconcile(operation); }, 750);
    }
  }

  async function stop(): Promise<void> {
    const current = latest.current;
    if (current.busy || [...operations.current.values()].some(operation => isCurrent(operation)
      && operation.scope.threadId === current.threadId
      && (!operation.record || operation.record.workUnitId === current.activeWorkUnitId))) return;
    const token = current.owner.beginWorkspaceAction("stop");
    if (!current.owner.isActionCurrent(token) || !current.threadId) return;
    const scope = { cwd: current.cwd.trim(), teammateId: current.teammateId, threadId: current.threadId };
    const operation: PrivateStopOperation = { key: `resolving:${token.actionGeneration}`, scope, token, revision: scopeRef.current.revision };
    operations.current.set(operation.key, operation);
    updatePending();
    current.owner.clearError(token);
    let dispatched = false;
    try {
      const resolution = await current.resolveReply(token);
      if (!isCurrent(operation)) return;
      if (resolution.status === "stale") {
        finish(operation);
        return;
      }
      const reply = resolution.activeReply;
      if (!reply) {
        current.owner.reportError(token, current.noActiveReplyMessage);
        finish(operation);
        return;
      }
      const before = await getWorkUnit(scope.cwd, reply.workUnitId);
      if (!isCurrent(operation)) return;
      const messageId = reply.messageId || before.workUnit.linkedMessageId;
      if (!messageId) throw new Error(current.pendingMessage);
      operation.record = { workUnitId: reply.workUnitId, messageId,
        linkedRunId: before.workUnit.linkedRunId, attemptId: before.workUnit.activeAttemptId };
      validateDetail(operation, before);
      try {
        privateStopLookupJournal.remember(scope, operation.record);
        operation.lookupStored = true;
      } catch {
        throw new Error(current.pendingMessage);
      }
      if (!["cancelled", "failed", "succeeded", "cancelling"].includes(before.workUnit.status)) {
        dispatched = true;
        await cancelTeammateDirectReply(scope.cwd, reply.workUnitId, { reason: "user_requested",
          expectedAttemptId: operation.record.attemptId ?? null, expectedRunId: operation.record.linkedRunId ?? null });
      }
      await reconcile(operation);
    } catch (error) {
      if (!isCurrent(operation)) return;
      latest.current.owner.reportError(token, error instanceof Error ? error.message : String(error));
      if (!dispatched) {
        finish(operation);
        return;
      }
      const rejected = error instanceof Error && "status" in error && typeof error.status === "number"
        && error.status >= 400 && error.status < 500 && error.status !== 408;
      await reconcile(operation, rejected);
    }
  }

  const stopping = pending.some(operation => isCurrent(operation) && operation.scope.threadId === options.threadId
    && (!options.activeWorkUnitId || !operation.record || options.activeWorkUnitId === operation.record.workUnitId));
  return { stopping, stop };
}

function operationKey(scope: PrivateStopLookupScope, record: PrivateStopLookupRecord): string {
  return JSON.stringify([scope.threadId, record.workUnitId, record.attemptId]);
}
