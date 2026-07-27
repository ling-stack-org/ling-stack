import type { FocusedDomainError } from "./use-focused-domain-error-owner.js";

export const SHELL_ERROR_PERSISTENT_DURATION_MS = 24 * 60 * 60 * 1000;

export interface ShellErrorFeedbackItem {
  readonly key: string;
  readonly error: FocusedDomainError | undefined;
  readonly surface: string;
  readonly visible: boolean;
}

export type ShellErrorFeedbackCommand =
  | {
      readonly type: "dismiss";
      readonly scope: string;
    }
  | {
      readonly type: "show";
      readonly error: FocusedDomainError;
      readonly scope: string;
    };

interface ActiveFeedback {
  readonly requestKey: string;
  readonly scope: string;
}

export interface ShellErrorFeedbackCoordinator {
  readonly closeAll: () => readonly string[];
  readonly markExplicitDismiss: (scope: string) => void;
  readonly reconcile: (items: readonly ShellErrorFeedbackItem[]) => readonly ShellErrorFeedbackCommand[];
}

const MAX_REMEMBERED_REQUESTS = 128;

export function createShellErrorFeedbackCoordinator(): ShellErrorFeedbackCoordinator {
  const activeByItem = new Map<string, ActiveFeedback>();
  const dismissedRequests = new Set<string>();
  const originSurfaceByRequest = new Map<string, string>();
  const rememberedRequests: string[] = [];
  const rememberedRequestSet = new Set<string>();

  function rememberRequest(requestKey: string): void {
    if (rememberedRequestSet.has(requestKey)) return;
    rememberedRequestSet.add(requestKey);
    rememberedRequests.push(requestKey);
    let pruneAttempts = rememberedRequests.length;
    while (rememberedRequests.length > MAX_REMEMBERED_REQUESTS && pruneAttempts > 0) {
      pruneAttempts -= 1;
      const oldest = rememberedRequests.shift();
      if (!oldest) continue;
      if ([...activeByItem.values()].some((active) => active.requestKey === oldest)) {
        rememberedRequests.push(oldest);
        continue;
      }
      rememberedRequestSet.delete(oldest);
      originSurfaceByRequest.delete(oldest);
      dismissedRequests.delete(oldest);
    }
  }

  return {
    closeAll: () => {
      const scopes = [...new Set([...activeByItem.values()].map((active) => active.scope))];
      activeByItem.clear();
      return scopes;
    },
    markExplicitDismiss: (scope) => {
      for (const [itemKey, active] of activeByItem) {
        if (active.scope !== scope) continue;
        dismissedRequests.add(active.requestKey);
        activeByItem.delete(itemKey);
      }
    },
    reconcile: (items) => {
      const commands: ShellErrorFeedbackCommand[] = [];
      const itemKeys = new Set(items.map((item) => item.key));
      for (const [itemKey, active] of activeByItem) {
        if (itemKeys.has(itemKey)) continue;
        commands.push({ type: "dismiss", scope: active.scope });
        activeByItem.delete(itemKey);
      }

      for (const item of items) {
        const active = activeByItem.get(item.key);
        if (!item.error) {
          if (active) {
            commands.push({ type: "dismiss", scope: active.scope });
            activeByItem.delete(item.key);
          }
          continue;
        }

        const requestKey = shellErrorRequestKey(item.key, item.error);
        rememberRequest(requestKey);
        if (!originSurfaceByRequest.has(requestKey) && item.visible) {
          originSurfaceByRequest.set(requestKey, item.surface);
        }
        const visibleOnOrigin = item.visible && originSurfaceByRequest.get(requestKey) === item.surface;
        const scope = shellErrorScope(item.error);

        if (active?.requestKey === requestKey) {
          if (!visibleOnOrigin || dismissedRequests.has(requestKey)) {
            commands.push({ type: "dismiss", scope: active.scope });
            activeByItem.delete(item.key);
          }
          continue;
        }

        if (active) {
          if (!visibleOnOrigin || dismissedRequests.has(requestKey) || active.scope !== scope) {
            commands.push({ type: "dismiss", scope: active.scope });
          }
          activeByItem.delete(item.key);
        }
        if (!visibleOnOrigin || dismissedRequests.has(requestKey)) continue;

        commands.push({ type: "show", error: item.error, scope });
        activeByItem.set(item.key, { requestKey, scope });
      }
      return commands;
    },
  };
}

function shellErrorRequestKey(itemKey: string, error: FocusedDomainError): string {
  return `${itemKey}:${error.domain}:${error.identity}:${error.objectId}:${error.action}:${error.requestId}`;
}

function shellErrorScope(error: FocusedDomainError): string {
  return `shell-error:${error.domain}:${error.objectId}:${error.action}`;
}
