import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface NormalConversationOperationToken<T> {
  readonly requestId: number;
  readonly ownerKey: string;
  readonly value: T;
}

export class NormalConversationOperationStore<T> {
  readonly #entries = new Map<number, NormalConversationOperationToken<T>>();
  #sequence = 0;

  begin(ownerKey: string, value: T): NormalConversationOperationToken<T> {
    const token = { requestId: ++this.#sequence, ownerKey, value };
    this.#entries.set(token.requestId, token);
    return token;
  }

  finish(token: NormalConversationOperationToken<T>): boolean {
    const current = this.#entries.get(token.requestId);
    if (!current || current.ownerKey !== token.ownerKey) return false;
    return this.#entries.delete(token.requestId);
  }

  current(ownerKey: string): NormalConversationOperationToken<T> | undefined {
    return [...this.#entries.values()].reverse().find((entry) => entry.ownerKey === ownerKey);
  }
}

export function useNormalConversationOperationOwner<T>(ownerKey: string): {
  readonly activeValue?: T;
  readonly busy: boolean;
  readonly begin: (value: T) => NormalConversationOperationToken<T>;
  readonly finish: (token: NormalConversationOperationToken<T>) => void;
} {
  const storeRef = useRef<NormalConversationOperationStore<T> | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new NormalConversationOperationStore<T>();
  const [revision, setRevision] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const begin = useCallback((value: T): NormalConversationOperationToken<T> => {
    const token = storeRef.current!.begin(ownerKey, value);
    if (mountedRef.current) setRevision((current) => current + 1);
    return token;
  }, [ownerKey]);
  const finish = useCallback((token: NormalConversationOperationToken<T>): void => {
    if (storeRef.current!.finish(token) && mountedRef.current) setRevision((current) => current + 1);
  }, []);
  const active = useMemo(() => storeRef.current!.current(ownerKey), [ownerKey, revision]);

  return useMemo(() => ({
    activeValue: active?.value,
    busy: Boolean(active),
    begin,
    finish,
  }), [active, begin, finish]);
}
