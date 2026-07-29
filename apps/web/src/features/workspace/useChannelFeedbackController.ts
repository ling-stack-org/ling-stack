import { useCallback, useMemo, useState } from "react";

export type ChannelFeedbackSurface =
  | "create-dialog"
  | "workspace"
  | "composer"
  | "task"
  | "workflow"
  | "protocol"
  | "dock"
  | "sidebar";

export type ChannelFeedbackScope =
  | "validation"
  | "load"
  | "mutation"
  | "stream";

export interface ChannelFeedbackEntry {
  readonly surface: ChannelFeedbackSurface;
  readonly identity: string;
  readonly scope: ChannelFeedbackScope;
  readonly message: string;
}

export interface ChannelFeedbackController {
  readonly entries: readonly ChannelFeedbackEntry[];
  readonly report: (entry: ChannelFeedbackEntry) => void;
  readonly clear: (surface: ChannelFeedbackSurface, identity: string) => void;
  readonly entry: (
    surface: ChannelFeedbackSurface,
    identity: string,
  ) => ChannelFeedbackEntry | undefined;
  readonly message: (
    surface: ChannelFeedbackSurface,
    identity: string,
  ) => string | undefined;
  readonly reset: () => void;
}

function feedbackKey(surface: ChannelFeedbackSurface, identity: string): string {
  return JSON.stringify([surface, identity]);
}

export function useChannelFeedbackController(): ChannelFeedbackController {
  const [feedbackByKey, setFeedbackByKey] = useState<
    ReadonlyMap<string, ChannelFeedbackEntry>
  >(() => new Map());

  const clear = useCallback((surface: ChannelFeedbackSurface, identity: string): void => {
    const key = feedbackKey(surface, identity);
    setFeedbackByKey((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  const report = useCallback((nextEntry: ChannelFeedbackEntry): void => {
    const key = feedbackKey(nextEntry.surface, nextEntry.identity);
    const normalizedMessage = nextEntry.message.trim();

    setFeedbackByKey((current) => {
      if (!normalizedMessage) {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      }

      const currentEntry = current.get(key);
      if (
        currentEntry?.scope === nextEntry.scope
        && currentEntry.message === normalizedMessage
      ) {
        return current;
      }

      const next = new Map(current);
      next.set(key, { ...nextEntry, message: normalizedMessage });
      return next;
    });
  }, []);

  const entry = useCallback((
    surface: ChannelFeedbackSurface,
    identity: string,
  ): ChannelFeedbackEntry | undefined => (
    feedbackByKey.get(feedbackKey(surface, identity))
  ), [feedbackByKey]);

  const message = useCallback((
    surface: ChannelFeedbackSurface,
    identity: string,
  ): string | undefined => (
    feedbackByKey.get(feedbackKey(surface, identity))?.message
  ), [feedbackByKey]);

  const reset = useCallback((): void => {
    setFeedbackByKey((current) => current.size === 0 ? current : new Map());
  }, []);

  const entries = useMemo(
    () => Array.from(feedbackByKey.values()),
    [feedbackByKey],
  );

  return useMemo(() => ({
    entries,
    report,
    clear,
    entry,
    message,
    reset,
  }), [clear, entries, entry, message, report, reset]);
}
