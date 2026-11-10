import { useCallback, useEffect, useMemo, useRef } from "react";
import { readConversationDraftGeneration } from "../../domains/conversations/conversation-surface-identity.js";

export interface NormalConversationIdentitySnapshot {
  readonly surface: "normal_conversation";
  readonly workspaceCwd: string;
  readonly threadId?: string;
  readonly draftGeneration?: number;
  readonly identity: string;
}

export function normalConversationIdentityOwnerKey(snapshot: NormalConversationIdentitySnapshot): string {
  return JSON.stringify([
    snapshot.surface,
    snapshot.workspaceCwd,
    snapshot.threadId ?? "",
    snapshot.draftGeneration ?? null,
    snapshot.identity,
  ]);
}

export function useNormalConversationIdentityController(input: {
  readonly workspaceCwd: string;
  readonly threadId?: string;
  readonly identity: string;
}): {
  readonly identity: string;
  readonly ownerKey: string;
  readonly ready: boolean;
  readonly capture: () => NormalConversationIdentitySnapshot;
  readonly isCurrent: (snapshot: NormalConversationIdentitySnapshot) => boolean;
  readonly createCommitGuard: () => (threadId?: string) => boolean;
} {
  const snapshot = useMemo<NormalConversationIdentitySnapshot>(() => {
    const identity = input.identity.trim();
    const candidateThreadId = input.threadId?.trim();
    return {
      surface: "normal_conversation",
      workspaceCwd: input.workspaceCwd.trim(),
      threadId: candidateThreadId === identity ? candidateThreadId : undefined,
      draftGeneration: readConversationDraftGeneration(identity),
      identity,
    };
  }, [input.identity, input.threadId, input.workspaceCwd]);
  const currentRef = useRef(snapshot);
  const mountedRef = useRef(true);
  currentRef.current = snapshot;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const capture = useCallback((): NormalConversationIdentitySnapshot => currentRef.current, []);
  const isCurrent = useCallback((candidate: NormalConversationIdentitySnapshot): boolean => (
    mountedRef.current && sameNormalConversationIdentity(currentRef.current, candidate)
  ), []);
  const createCommitGuard = useCallback((): ((threadId?: string) => boolean) => {
    return createNormalConversationIdentityCommitGuard({
      origin: currentRef.current,
      isMounted: () => mountedRef.current,
      readCurrent: () => currentRef.current,
    });
  }, []);

  return useMemo(() => ({
    identity: snapshot.identity,
    ownerKey: normalConversationIdentityOwnerKey(snapshot),
    ready: Boolean(snapshot.workspaceCwd && (snapshot.threadId || snapshot.draftGeneration !== undefined)),
    capture,
    isCurrent,
    createCommitGuard,
  }), [capture, createCommitGuard, isCurrent, snapshot]);
}

export function createNormalConversationIdentityCommitGuard(input: {
  readonly origin: NormalConversationIdentitySnapshot;
  readonly isMounted: () => boolean;
  readonly readCurrent: () => NormalConversationIdentitySnapshot;
}): (threadId?: string) => boolean {
  let boundThreadId = input.origin.threadId ?? "";
  return (responseThreadId?: string): boolean => {
    if (!input.isMounted()) return false;
    if (!boundThreadId && responseThreadId) boundThreadId = responseThreadId;
    const current = input.readCurrent();
    if (current.workspaceCwd !== input.origin.workspaceCwd) return false;
    return sameNormalConversationIdentity(current, input.origin)
      || Boolean(boundThreadId && current.identity === boundThreadId);
  };
}

function sameNormalConversationIdentity(
  left: NormalConversationIdentitySnapshot,
  right: NormalConversationIdentitySnapshot,
): boolean {
  return left.surface === right.surface
    && left.workspaceCwd === right.workspaceCwd
    && left.threadId === right.threadId
    && left.draftGeneration === right.draftGeneration
    && left.identity === right.identity;
}
