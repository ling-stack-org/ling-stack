const workspaceCwdStorageKey = "ling-stack.workspaceCwd";
const viteDefaultWorkspaceCwd = import.meta.env.VITE_LING_STACK_DEFAULT_WORKSPACE_CWD?.trim() ?? "";

export function readSavedWorkspaceCwd(): string {
  try {
    return globalThis.localStorage?.getItem(workspaceCwdStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function clearSavedWorkspaceCwd(): void {
  try {
    globalThis.localStorage?.removeItem(workspaceCwdStorageKey);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function readInitialWorkspaceCwd(): string {
  return readSavedWorkspaceCwd() || viteDefaultWorkspaceCwd;
}

export function getViteDefaultWorkspaceCwd(): string {
  return viteDefaultWorkspaceCwd;
}
