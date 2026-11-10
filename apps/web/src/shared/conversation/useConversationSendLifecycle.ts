import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationActiveReplyTarget } from "../../types.js";
import {
  ConversationSendLifecycleStore,
  type ConversationSendLifecycleSnapshot,
  type ConversationSendOperation,
} from "./conversation-send-lifecycle.js";

export interface ConversationSendLifecycleController extends ConversationSendLifecycleSnapshot {
  readonly begin: () => ConversationSendOperation;
  readonly accept: (operation: ConversationSendOperation) => boolean;
  readonly link: (operation: ConversationSendOperation, target: ConversationActiveReplyTarget) => boolean;
  readonly settle: (operation: ConversationSendOperation) => boolean;
  readonly defer: (operation: ConversationSendOperation) => boolean;
  readonly fail: (operation: ConversationSendOperation) => { readonly accepted: boolean; readonly restoreInput: boolean };
}

export function useConversationSendLifecycle(ownerKey: string): ConversationSendLifecycleController {
  const storeRef = useRef<ConversationSendLifecycleStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new ConversationSendLifecycleStore(ownerKey);
  const [snapshot, setSnapshot] = useState(() => storeRef.current!.snapshot());

  useEffect(() => {
    storeRef.current!.reset(ownerKey);
    setSnapshot(storeRef.current!.snapshot());
  }, [ownerKey]);

  const commit = useCallback(<T,>(mutation: (store: ConversationSendLifecycleStore) => T): T => {
    const result = mutation(storeRef.current!);
    setSnapshot(storeRef.current!.snapshot());
    return result;
  }, []);

  const begin = useCallback(() => commit((store) => store.begin(ownerKey)), [commit, ownerKey]);
  const accept = useCallback((operation: ConversationSendOperation) => commit((store) => store.accept(operation)), [commit]);
  const link = useCallback((operation: ConversationSendOperation, target: ConversationActiveReplyTarget) => (
    commit((store) => store.link(operation, target))
  ), [commit]);
  const settle = useCallback((operation: ConversationSendOperation) => commit((store) => store.settle(operation)), [commit]);
  const defer = useCallback((operation: ConversationSendOperation) => commit((store) => store.defer(operation)), [commit]);
  const fail = useCallback((operation: ConversationSendOperation) => commit((store) => store.fail(operation)), [commit]);

  return { ...snapshot, begin, accept, link, settle, defer, fail };
}
