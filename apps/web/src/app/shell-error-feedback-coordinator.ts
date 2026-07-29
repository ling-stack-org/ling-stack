import type { FocusedDomainError } from "./use-focused-domain-error-owner.js";

export const SHELL_ERROR_PERSISTENT_DURATION_MS = 24 * 60 * 60 * 1000;
export const SHELL_ERROR_TOAST_CAPACITY = 3;

export interface ShellErrorFeedbackItem {
  readonly key: string;
  readonly error: FocusedDomainError | undefined;
  readonly surface: string;
  readonly visible: boolean;
}

export interface ShellErrorToastViewportSnapshot {
  readonly maxVisible: number;
  readonly openScopes: ReadonlySet<string>;
  readonly openToastCount: number;
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
  readonly error: FocusedDomainError;
  readonly requestKey: string;
  readonly scope: string;
}

interface FeedbackCandidate extends ActiveFeedback {
  readonly itemKey: string;
  readonly order: number;
  readonly replacesOpenScope: boolean;
}

export interface ShellErrorFeedbackCoordinator {
  readonly closeAll: () => readonly string[];
  readonly markExplicitDismiss: (scope: string) => void;
  readonly observeViewport: (
    items: readonly ShellErrorFeedbackItem[],
    viewport: ShellErrorToastViewportSnapshot,
  ) => readonly ShellErrorFeedbackCommand[];
  readonly reconcile: (
    items: readonly ShellErrorFeedbackItem[],
    viewport?: ShellErrorToastViewportSnapshot,
  ) => readonly ShellErrorFeedbackCommand[];
}

export function createShellErrorFeedbackCoordinator(): ShellErrorFeedbackCoordinator {
  const activeByItem = new Map<string, ActiveFeedback>();
  const dismissedErrors = new WeakSet<FocusedDomainError>();
  const originSurfaceByError = new WeakMap<FocusedDomainError, string>();
  const pendingOrderByError = new WeakMap<FocusedDomainError, number>();
  let pendingSequence = 0;

  function pendingOrder(error: FocusedDomainError): number {
    const existing = pendingOrderByError.get(error);
    if (existing !== undefined) return existing;
    const order = ++pendingSequence;
    pendingOrderByError.set(error, order);
    return order;
  }

  function reconcile(
    items: readonly ShellErrorFeedbackItem[],
    viewport?: ShellErrorToastViewportSnapshot,
    observeAbsence = false,
  ): readonly ShellErrorFeedbackCommand[] {
    const commands: ShellErrorFeedbackCommand[] = [];
    const itemKeys = new Set(items.map((item) => item.key));
    for (const [itemKey, active] of activeByItem) {
      if (itemKeys.has(itemKey)) continue;
      commands.push({ type: "dismiss", scope: active.scope });
      activeByItem.delete(itemKey);
    }

    if (viewport && observeAbsence) {
      for (const [itemKey, active] of activeByItem) {
        if (viewport.openScopes.has(active.scope)) continue;
        pendingOrder(active.error);
        activeByItem.delete(itemKey);
      }
    }

    const candidates: FeedbackCandidate[] = [];
    for (const item of items) {
      const active = activeByItem.get(item.key);
      if (!item.error) {
        if (active) {
          commands.push({ type: "dismiss", scope: active.scope });
          activeByItem.delete(item.key);
        }
        continue;
      }

      const error = item.error;
      if (!originSurfaceByError.has(error)) originSurfaceByError.set(error, item.surface);
      const visibleOnOrigin = item.visible && originSurfaceByError.get(error) === item.surface;
      const dismissed = dismissedErrors.has(error);
      const requestKey = shellErrorRequestKey(item.key, error);
      const scope = shellErrorScope(error);

      if (active?.requestKey === requestKey) {
        if (!visibleOnOrigin || dismissed) {
          commands.push({ type: "dismiss", scope: active.scope });
          activeByItem.delete(item.key);
        }
        continue;
      }

      let replacesOpenScope = viewport?.openScopes.has(scope) ?? false;
      if (active) {
        if (active.scope === scope) {
          replacesOpenScope = replacesOpenScope || !viewport;
        } else {
          commands.push({ type: "dismiss", scope: active.scope });
        }
        activeByItem.delete(item.key);
      }
      if (!visibleOnOrigin || dismissed) continue;

      candidates.push({
        error,
        itemKey: item.key,
        order: pendingOrder(error),
        replacesOpenScope,
        requestKey,
        scope,
      });
    }

    candidates.sort((left, right) => left.order - right.order);
    let availableSlots = viewport
      ? Math.max(0, viewport.maxVisible - viewport.openToastCount - reservedToastCount(activeByItem, viewport))
      : Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (!candidate.replacesOpenScope && availableSlots <= 0) continue;
      commands.push({ type: "show", error: candidate.error, scope: candidate.scope });
      activeByItem.set(candidate.itemKey, candidate);
      pendingOrderByError.delete(candidate.error);
      if (!candidate.replacesOpenScope) availableSlots -= 1;
    }
    return commands;
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
        dismissedErrors.add(active.error);
        pendingOrderByError.delete(active.error);
        activeByItem.delete(itemKey);
      }
    },
    observeViewport: (items, viewport) => reconcile(items, viewport, true),
    reconcile: (items, viewport) => reconcile(items, viewport),
  };
}

function reservedToastCount(
  activeByItem: ReadonlyMap<string, ActiveFeedback>,
  viewport: ShellErrorToastViewportSnapshot,
): number {
  const reservedScopes = new Set<string>();
  for (const active of activeByItem.values()) {
    if (!viewport.openScopes.has(active.scope)) reservedScopes.add(active.scope);
  }
  return reservedScopes.size;
}

function shellErrorRequestKey(itemKey: string, error: FocusedDomainError): string {
  return `${itemKey}:${error.domain}:${error.identity}:${error.objectId}:${error.action}:${error.requestId}`;
}

function shellErrorScope(error: FocusedDomainError): string {
  return `shell-error:${error.domain}:${error.objectId}:${error.action}`;
}
