import { useCallback, useMemo, useRef, useState } from "react";

export type ConversationErrorSurface = "sidebar" | "thread" | "composer";

export type ConversationErrorScope =
  | "load"
  | "select"
  | "refresh"
  | "archive"
  | "stream"
  | "action";

export interface ConversationErrorEntry {
  readonly workspaceCwd: string;
  readonly surface: ConversationErrorSurface;
  readonly identity: string;
  readonly scope: ConversationErrorScope;
  readonly message: string;
  readonly origin?: "transport";
  readonly sequence: number;
}

export interface ConversationErrorOperation {
  readonly workspaceCwd: string;
  readonly surface: ConversationErrorSurface;
  readonly identity: string;
  readonly scope: ConversationErrorScope;
  readonly sequence: number;
}

export interface ConversationErrorQuery {
  readonly workspaceCwd: string;
  readonly surface: ConversationErrorSurface;
  readonly identity?: string;
  readonly scopes?: readonly ConversationErrorScope[];
  readonly excludeTransport?: boolean;
}

export class ConversationErrorStore {
  private sequence = 0;
  private readonly latestOperationByKey = new Map<string, number>();
  private readonly entryByKey = new Map<string, ConversationErrorEntry>();

  begin(input: Omit<ConversationErrorOperation, "sequence">): ConversationErrorOperation {
    const operation = { ...input, sequence: ++this.sequence };
    this.latestOperationByKey.set(conversationErrorKey(operation), operation.sequence);
    return operation;
  }

  isCurrent(operation: ConversationErrorOperation): boolean {
    return this.latestOperationByKey.get(conversationErrorKey(operation)) === operation.sequence;
  }

  report(operation: ConversationErrorOperation, message: string, origin?: "transport"): boolean {
    if (!this.isCurrent(operation)) return false;
    const normalizedMessage = message.trim();
    if (!normalizedMessage) return this.clear(operation);
    const key = conversationErrorKey(operation);
    const current = this.entryByKey.get(key);
    if (current?.message === normalizedMessage && current.sequence === operation.sequence && current.origin === origin) return false;
    this.entryByKey.set(key, { ...operation, message: normalizedMessage, origin });
    return true;
  }

  clear(operation: ConversationErrorOperation): boolean {
    if (!this.isCurrent(operation)) return false;
    return this.entryByKey.delete(conversationErrorKey(operation));
  }

  entries(): readonly ConversationErrorEntry[] {
    return [...this.entryByKey.values()].sort((left, right) => left.sequence - right.sequence);
  }
}

export function selectConversationError(
  entries: readonly ConversationErrorEntry[],
  query: ConversationErrorQuery,
): ConversationErrorEntry | undefined {
  const scopes = query.scopes ? new Set(query.scopes) : undefined;
  return [...entries].reverse().find((entry) =>
    entry.workspaceCwd === query.workspaceCwd
    && entry.surface === query.surface
    && (query.identity === undefined || entry.identity === query.identity)
    && (!scopes || scopes.has(entry.scope))
    && (!query.excludeTransport || entry.origin !== "transport")
  );
}

export function useConversationErrorOwner(): {
  readonly entries: readonly ConversationErrorEntry[];
  readonly begin: (input: Omit<ConversationErrorOperation, "sequence">) => ConversationErrorOperation;
  readonly isCurrent: (operation: ConversationErrorOperation) => boolean;
  readonly report: (operation: ConversationErrorOperation, message: string, origin?: "transport") => void;
  readonly clear: (operation: ConversationErrorOperation) => void;
} {
  const storeRef = useRef<ConversationErrorStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new ConversationErrorStore();
  const [entries, setEntries] = useState<readonly ConversationErrorEntry[]>([]);

  const begin = useCallback((input: Omit<ConversationErrorOperation, "sequence">): ConversationErrorOperation => (
    storeRef.current!.begin(input)
  ), []);

  const isCurrent = useCallback((operation: ConversationErrorOperation): boolean => (
    storeRef.current!.isCurrent(operation)
  ), []);

  const publishIfChanged = useCallback((changed: boolean): void => {
    if (changed) setEntries(storeRef.current!.entries());
  }, []);

  const report = useCallback((operation: ConversationErrorOperation, message: string, origin?: "transport"): void => {
    publishIfChanged(storeRef.current!.report(operation, message, origin));
  }, [publishIfChanged]);

  const clear = useCallback((operation: ConversationErrorOperation): void => {
    publishIfChanged(storeRef.current!.clear(operation));
  }, [publishIfChanged]);

  return useMemo(() => ({ entries, begin, isCurrent, report, clear }), [begin, clear, entries, isCurrent, report]);
}

function conversationErrorKey(input: Pick<
  ConversationErrorOperation,
  "workspaceCwd" | "surface" | "identity" | "scope"
>): string {
  return JSON.stringify([input.workspaceCwd, input.surface, input.identity, input.scope]);
}
