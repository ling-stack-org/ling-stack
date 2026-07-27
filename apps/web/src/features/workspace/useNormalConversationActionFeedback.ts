import { useCallback, useMemo, useState } from "react";

export type NormalConversationActionScope =
  | "validation"
  | "stream"
  | "edit"
  | "replacement"
  | "attachment";

interface NormalConversationActionFeedbackEntry {
  readonly identity: string;
  readonly scope: NormalConversationActionScope;
  readonly message: string;
  readonly sequence: number;
}

export function useNormalConversationActionFeedback(identity: string): {
  readonly message: string;
  readonly messageFor: (scope: NormalConversationActionScope) => string;
  readonly report: (scope: NormalConversationActionScope, message: string) => void;
  readonly clear: (scope: NormalConversationActionScope) => void;
} {
  const [entries, setEntries] = useState<readonly NormalConversationActionFeedbackEntry[]>([]);

  const report = useCallback((scope: NormalConversationActionScope, message: string): void => {
    const normalizedMessage = message.trim();
    setEntries((current) => {
      const remaining = current.filter((entry) => entry.identity !== identity || entry.scope !== scope);
      if (!normalizedMessage) return remaining.length === current.length ? current : remaining;
      return [...remaining, {
        identity,
        scope,
        message: normalizedMessage,
        sequence: (current.at(-1)?.sequence ?? 0) + 1,
      }];
    });
  }, [identity]);

  const clear = useCallback((scope: NormalConversationActionScope): void => {
    setEntries((current) => {
      const next = current.filter((entry) => entry.identity !== identity || entry.scope !== scope);
      return next.length === current.length ? current : next;
    });
  }, [identity]);

  const message = useMemo(() => (
    [...entries].reverse().find((entry) => entry.identity === identity)?.message ?? ""
  ), [entries, identity]);

  const messageFor = useCallback((scope: NormalConversationActionScope): string => (
    [...entries].reverse().find((entry) => entry.identity === identity && entry.scope === scope)?.message ?? ""
  ), [entries, identity]);

  return useMemo(() => ({ message, messageFor, report, clear }), [clear, message, messageFor, report]);
}
