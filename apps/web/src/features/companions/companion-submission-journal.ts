const prefix = "ling-stack.companion-submission.v1:";

interface PendingCompanionSubmission {
  readonly key: string;
  readonly terminal?: boolean;
}

function storageKey(cwd: string, companionId: string): string {
  return `${prefix}${JSON.stringify([cwd.trim(), companionId])}`;
}

export function readPendingCompanionSubmission(cwd: string, companionId: string): PendingCompanionSubmission | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey(cwd, companionId));
    if (!raw || raw.length > 400 || /[\r\n]/u.test(raw)) return undefined;
    if (!raw.startsWith("{")) return raw.length <= 200 ? { key: raw } : undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const key = (parsed as { readonly key?: unknown }).key;
    if (typeof key !== "string" || !key || key.length > 200 || /[\r\n]/u.test(key)) return undefined;
    return { key, ...((parsed as { readonly terminal?: unknown }).terminal === true ? { terminal: true } : {}) };
  } catch { return undefined; }
}

export function rememberPendingCompanionSubmission(cwd: string, companionId: string, key: string): void {
  if (typeof window === "undefined" || !key || key.length > 200 || /[\r\n]/u.test(key)) return;
  try { window.localStorage.setItem(storageKey(cwd, companionId), key); } catch { /* The active chat retains its key in memory when storage is unavailable. */ }
}

export function markPendingCompanionSubmissionTerminal(cwd: string, companionId: string, key: string): void {
  if (typeof window === "undefined" || !key || key.length > 200 || /[\r\n]/u.test(key)) return;
  const current = readPendingCompanionSubmission(cwd, companionId);
  if (current?.key !== key) return;
  try { window.localStorage.setItem(storageKey(cwd, companionId), JSON.stringify({ key, terminal: true })); } catch { /* The active chat retains the terminal marker when storage is unavailable. */ }
}

export function forgetPendingCompanionSubmission(cwd: string, companionId: string, key: string): void {
  if (typeof window === "undefined") return;
  const current = readPendingCompanionSubmission(cwd, companionId);
  if (current?.key === key) {
    try { window.localStorage.removeItem(storageKey(cwd, companionId)); } catch { /* Receipt lookup can reconcile a retained journal entry. */ }
  }
}
