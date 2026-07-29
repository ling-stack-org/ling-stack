import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ConversationStreamBusyOperation {
  readonly requestId: number;
  readonly workspaceCwd: string;
  readonly originIdentity: string;
}

interface ConversationStreamBusyEntry extends ConversationStreamBusyOperation {
  boundThreadId?: string;
}

export class ConversationStreamBusyStore {
  readonly #entries = new Map<number, ConversationStreamBusyEntry>();
  #sequence = 0;

  begin(input: { readonly workspaceCwd: string; readonly identity: string }): ConversationStreamBusyOperation {
    const operation = {
      requestId: ++this.#sequence,
      workspaceCwd: input.workspaceCwd,
      originIdentity: input.identity,
    };
    this.#entries.set(operation.requestId, operation);
    return operation;
  }

  bind(operation: ConversationStreamBusyOperation, threadId: string): boolean {
    const entry = this.#entries.get(operation.requestId);
    if (!entry || entry.workspaceCwd !== operation.workspaceCwd || entry.originIdentity !== operation.originIdentity) {
      return false;
    }
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId || entry.boundThreadId === normalizedThreadId) return false;
    entry.boundThreadId = normalizedThreadId;
    return true;
  }

  finish(operation: ConversationStreamBusyOperation): boolean {
    const entry = this.#entries.get(operation.requestId);
    if (!entry || entry.workspaceCwd !== operation.workspaceCwd || entry.originIdentity !== operation.originIdentity) {
      return false;
    }
    return this.#entries.delete(operation.requestId);
  }

  isBusy(input: { readonly workspaceCwd: string; readonly identity: string }): boolean {
    for (const entry of this.#entries.values()) {
      if (entry.workspaceCwd !== input.workspaceCwd) continue;
      if (entry.originIdentity === input.identity || entry.boundThreadId === input.identity) return true;
    }
    return false;
  }
}

export function useConversationStreamBusyOwner(): {
  readonly begin: (input: { readonly workspaceCwd: string; readonly identity: string }) => ConversationStreamBusyOperation;
  readonly bind: (operation: ConversationStreamBusyOperation, threadId: string) => void;
  readonly finish: (operation: ConversationStreamBusyOperation) => void;
  readonly isBusy: (input: { readonly workspaceCwd: string; readonly identity: string }) => boolean;
} {
  const storeRef = useRef<ConversationStreamBusyStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new ConversationStreamBusyStore();
  const [, setRevision] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const begin = useCallback((input: { readonly workspaceCwd: string; readonly identity: string }) => {
    const operation = storeRef.current!.begin(input);
    if (mountedRef.current) setRevision((current) => current + 1);
    return operation;
  }, []);
  const bind = useCallback((operation: ConversationStreamBusyOperation, threadId: string): void => {
    if (storeRef.current!.bind(operation, threadId) && mountedRef.current) setRevision((current) => current + 1);
  }, []);
  const finish = useCallback((operation: ConversationStreamBusyOperation): void => {
    if (storeRef.current!.finish(operation) && mountedRef.current) setRevision((current) => current + 1);
  }, []);
  const isBusy = useCallback((input: { readonly workspaceCwd: string; readonly identity: string }): boolean => (
    storeRef.current!.isBusy(input)
  ), []);

  return useMemo(() => ({ begin, bind, finish, isBusy }), [begin, bind, finish, isBusy]);
}
