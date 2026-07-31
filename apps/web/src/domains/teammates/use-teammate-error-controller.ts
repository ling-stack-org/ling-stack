import { useCallback, useMemo, useRef, useState } from "react";

export type TeammateErrorSurface = "list" | "teammate" | "channel-relation";
export type TeammateErrorScope = "load" | "validation" | "mutation";
export type TeammateErrorAction =
  | "load"
  | "load-memberships"
  | "disable"
  | "hard-delete"
  | "update"
  | "rename"
  | "profile-save"
  | "persona-apply"
  | "model-save"
  | "permissions-save"
  | "pin"
  | "visibility"
  | "archive"
  | "add"
  | "remove"
  | "set-default";

export type TeammateMutationAction = Exclude<TeammateErrorAction, "load" | "load-memberships" | "add" | "remove" | "set-default">;
export type TeammateChannelRelationAction = Extract<TeammateErrorAction, "add" | "remove" | "set-default">;

export interface TeammateScopedError {
  readonly surface: TeammateErrorSurface;
  readonly identity: string;
  readonly action: TeammateErrorAction;
  readonly scope: TeammateErrorScope;
  readonly message: string;
  readonly revision: number;
}

export interface TeammateChannelRelationError {
  readonly teammateId: string;
  readonly action: TeammateChannelRelationAction;
  readonly message: string;
  readonly revision: number;
}

export interface TeammateErrorController {
  readonly entries: readonly TeammateScopedError[];
  readonly report: (input: Omit<TeammateScopedError, "message" | "revision">, caught: unknown) => string;
  readonly clear: (surface: TeammateErrorSurface, identity: string, action?: TeammateErrorAction) => void;
  readonly reset: () => void;
}

export function useTeammateErrorController(): TeammateErrorController {
  const [entries, setEntries] = useState<readonly TeammateScopedError[]>([]);
  const revisionRef = useRef(0);

  const report = useCallback((
    input: Omit<TeammateScopedError, "message" | "revision">,
    caught: unknown,
  ): string => {
    const message = caught instanceof Error ? caught.message : String(caught);
    const revision = ++revisionRef.current;
    setEntries((current) => [
      ...current.filter((entry) => !sameOwner(entry, input.surface, input.identity, input.action)),
      { ...input, message, revision },
    ]);
    return message;
  }, []);

  const clear = useCallback((
    surface: TeammateErrorSurface,
    identity: string,
    action?: TeammateErrorAction,
  ): void => {
    setEntries((current) => {
      const next = current.filter((entry) => (
        entry.surface !== surface || entry.identity !== identity || (action !== undefined && entry.action !== action)
      ));
      return next.length === current.length ? current : next;
    });
  }, []);

  const reset = useCallback((): void => {
    revisionRef.current += 1;
    setEntries((current) => current.length === 0 ? current : []);
  }, []);

  return useMemo(() => ({ entries, report, clear, reset }), [clear, entries, report, reset]);
}

export function latestTeammateListError(
  entries: readonly TeammateScopedError[],
): TeammateScopedError | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.surface === "list") return entry;
  }
  return undefined;
}

export function teammateActionErrorMessages(
  entries: readonly TeammateScopedError[],
): Readonly<Record<string, string>> {
  const messages: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.surface === "teammate") messages[entry.identity] = entry.message;
  }
  return messages;
}

export function teammateChannelRelationIdentity(channelId: string, teammateId: string): string {
  return JSON.stringify([channelId, teammateId]);
}

export function latestTeammateChannelRelationErrorByChannelId(
  entries: readonly TeammateScopedError[],
): Readonly<Record<string, TeammateChannelRelationError>> {
  const errorsByChannelId: Record<string, TeammateChannelRelationError> = {};
  for (const entry of entries) {
    if (entry.surface !== "channel-relation") continue;
    if (!isTeammateChannelRelationAction(entry.action)) continue;
    const relation = channelRelationFromIdentity(entry.identity);
    if (!relation) continue;
    const current = errorsByChannelId[relation.channelId];
    if (!current || current.revision < entry.revision) {
      errorsByChannelId[relation.channelId] = {
        teammateId: relation.teammateId,
        action: entry.action,
        message: entry.message,
        revision: entry.revision,
      };
    }
  }
  return errorsByChannelId;
}

function isTeammateChannelRelationAction(action: TeammateErrorAction): action is TeammateChannelRelationAction {
  return action === "add" || action === "remove" || action === "set-default";
}

function channelRelationFromIdentity(
  identity: string,
): { readonly channelId: string; readonly teammateId: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(identity);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
      return undefined;
    }
    return { channelId: parsed[0], teammateId: parsed[1] };
  } catch {
    return undefined;
  }
}

function sameOwner(
  entry: TeammateScopedError,
  surface: TeammateErrorSurface,
  identity: string,
  action: TeammateErrorAction,
): boolean {
  return entry.surface === surface && entry.identity === identity && entry.action === action;
}
