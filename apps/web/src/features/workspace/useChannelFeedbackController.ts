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
  readonly workspaceCwd: string;
  readonly surface: ChannelFeedbackSurface;
  readonly identity: string;
  readonly scope: ChannelFeedbackScope;
  readonly message: string;
}

export interface ChannelFeedbackController {
  readonly entries: readonly ChannelFeedbackEntry[];
  readonly report: (entry: ChannelFeedbackEntry) => void;
  readonly clear: (surface: ChannelFeedbackSurface, identity: string, workspaceCwd: string) => void;
  readonly entry: (
    surface: ChannelFeedbackSurface,
    identity: string,
    workspaceCwd: string,
  ) => ChannelFeedbackEntry | undefined;
  readonly message: (
    surface: ChannelFeedbackSurface,
    identity: string,
    workspaceCwd: string,
  ) => string | undefined;
  readonly reset: () => void;
}

function feedbackKey(workspaceCwd: string, surface: ChannelFeedbackSurface, identity: string): string {
  return JSON.stringify([workspaceCwd.trim(), surface, identity]);
}

export function useChannelFeedbackController(): ChannelFeedbackController {
  const [feedbackByKey, setFeedbackByKey] = useState<
    ReadonlyMap<string, ChannelFeedbackEntry>
  >(() => new Map());

  const clear = useCallback((surface: ChannelFeedbackSurface, identity: string, workspaceCwd: string): void => {
    setFeedbackByKey((current) => {
      const next = new Map(current);
      for (const [key, entry] of current) {
        if (entry.surface !== surface || entry.identity !== identity) continue;
        if (entry.workspaceCwd !== workspaceCwd.trim()) continue;
        next.delete(key);
      }
      if (next.size === current.size) return current;
      return next;
    });
  }, []);

  const report = useCallback((nextEntry: ChannelFeedbackEntry): void => {
    const normalizedWorkspaceCwd = nextEntry.workspaceCwd.trim();
    const key = feedbackKey(normalizedWorkspaceCwd, nextEntry.surface, nextEntry.identity);
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
      next.set(key, { ...nextEntry, workspaceCwd: normalizedWorkspaceCwd, message: normalizedMessage });
      return next;
    });
  }, []);

  const entry = useCallback((
    surface: ChannelFeedbackSurface,
    identity: string,
    workspaceCwd: string,
  ): ChannelFeedbackEntry | undefined => (
    feedbackByKey.get(feedbackKey(workspaceCwd, surface, identity))
  ), [feedbackByKey]);

  const message = useCallback((
    surface: ChannelFeedbackSurface,
    identity: string,
    workspaceCwd: string,
  ): string | undefined => (
    entry(surface, identity, workspaceCwd)?.message
  ), [entry]);

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
