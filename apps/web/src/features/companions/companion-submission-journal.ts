const prefix = "ling-stack.companion-submission.v1:";

interface PendingCompanionSubmission {
  readonly key: string;
}

function storageKey(cwd: string, companionId: string): string {
  return `${prefix}${JSON.stringify([cwd.trim(), companionId])}`;
}

export function readPendingCompanionSubmission(cwd: string, companionId: string): PendingCompanionSubmission | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey(cwd, companionId));
    if (!raw || raw.length > 200 || /[\r\n]/u.test(raw)) return undefined;
    return { key: raw };
  } catch { return undefined; }
}

export function rememberPendingCompanionSubmission(cwd: string, companionId: string, key: string): void {
  if (typeof window === "undefined" || !key || key.length > 200 || /[\r\n]/u.test(key)) return;
  try { window.localStorage.setItem(storageKey(cwd, companionId), key); } catch { /* The active chat retains its key in memory when storage is unavailable. */ }
}

export function forgetPendingCompanionSubmission(cwd: string, companionId: string, key: string): void {
  if (typeof window === "undefined") return;
  const current = readPendingCompanionSubmission(cwd, companionId);
  if (current?.key === key) {
    try { window.localStorage.removeItem(storageKey(cwd, companionId)); } catch { /* Receipt lookup can reconcile a retained journal entry. */ }
  }
}
