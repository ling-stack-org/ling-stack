import type { ConversationCopyFeedbackState, ConversationDisclosureKind, ConversationViewState } from "./conversation-view-store.js";

export function selectDisclosureExpanded(
  state: ConversationViewState,
  kind: ConversationDisclosureKind,
  id: string,
  fallback: boolean,
): boolean {
  const map = kind === "block" ? state.blockDisclosureById : state.spanDisclosureById;
  return map.get(id)?.expanded ?? fallback;
}

export function selectActionActive(state: ConversationViewState, actionId: string): boolean {
  return state.activeActionId === actionId;
}

export function selectActionCopyFeedback(
  state: ConversationViewState,
  actionId: string,
): ConversationCopyFeedbackState | undefined {
  return state.copyFeedbackByActionId.get(actionId);
}

export function selectActionCopied(state: ConversationViewState, actionId: string): boolean {
  return selectActionCopyFeedback(state, actionId) !== undefined;
}
