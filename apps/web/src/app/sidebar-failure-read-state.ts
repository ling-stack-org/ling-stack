const sidebarFailureReadStorageKey = "ling-stack.sidebar-failure-read.v1";

export type SidebarFailureReadState = Readonly<Record<string, string>>;

export function readSidebarFailureReadState(): SidebarFailureReadState {
  if (typeof localStorage === "undefined") return {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(sidebarFailureReadStorageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].length > 0
    )));
  } catch {
    return {};
  }
}

export function writeSidebarFailureReadState(state: SidebarFailureReadState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(sidebarFailureReadStorageKey, JSON.stringify(state));
  } catch {
    // Read acknowledgements are optional local UI state.
  }
}

export function acknowledgeSidebarConversationFailure(
  state: SidebarFailureReadState,
  workspaceIdentity: string,
  conversationId: string,
  failureUpdatedAt: string,
): SidebarFailureReadState {
  const key = sidebarFailureIdentity(workspaceIdentity, conversationId);
  const current = state[key];
  if (current && current.localeCompare(failureUpdatedAt) >= 0) return state;
  return { ...state, [key]: failureUpdatedAt };
}

export function hasAcknowledgedSidebarConversationFailure(
  state: SidebarFailureReadState,
  workspaceIdentity: string,
  conversationId: string,
  failureUpdatedAt: string,
): boolean {
  const viewedAt = state[sidebarFailureIdentity(workspaceIdentity, conversationId)];
  return Boolean(viewedAt && viewedAt.localeCompare(failureUpdatedAt) >= 0);
}

function sidebarFailureIdentity(workspaceIdentity: string, conversationId: string): string {
  return JSON.stringify([workspaceIdentity.trim(), conversationId]);
}
