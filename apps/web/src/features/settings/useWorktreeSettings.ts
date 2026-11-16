import { useEffect, useRef, useState } from "react";
import type { ManagedWorktreeActionRequest, ManagedWorktreeEntry, ManagedWorktreeListResponse, WorktreeEnvironment, WorktreePolicy } from "@ling-stack/contracts";
import { actOnManagedWorktree, listManagedWorktrees } from "../../api/worktrees.js";
import { updateWorkspaceSettings } from "../../api/workspace-settings.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";

export function useWorktreeSettings(cwd: string) {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [data, setData] = useState<ManagedWorktreeListResponse>();
  const [rootDir, setRootDir] = useState("");
  const [fetchBeforeCreate, setFetchBeforeCreate] = useState(false);
  const [autoCleanup, setAutoCleanup] = useState(false);
  const [retainCount, setRetainCount] = useState("15");
  const [confirmBeforeDelete, setConfirmBeforeDelete] = useState(true);
  const [environment, setEnvironment] = useState<WorktreeEnvironment>({ enabled: false, setupScript: "", variables: {}, timeoutSeconds: 120 });
  const [variablesText, setVariablesText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [cleanupTarget, setCleanupTarget] = useState<ManagedWorktreeEntry>();
  const [cleanupError, setCleanupError] = useState("");
  const sequence = useRef(0);

  function apply(next: ManagedWorktreeListResponse, resetDraft = true): void {
    setData(next);
    if (!resetDraft) return;
    setRootDir(next.policy.rootDir ?? "");
    setFetchBeforeCreate(next.policy.fetchBeforeCreate);
    setAutoCleanup(next.policy.autoCleanup ?? false);
    setRetainCount(String(next.policy.retainCount ?? 15));
    setConfirmBeforeDelete(next.policy.confirmBeforeDelete ?? true);
    const env = next.policy.environment ?? { enabled: false, setupScript: "", variables: {}, timeoutSeconds: 120 };
    setEnvironment(env);
    setVariablesText(Object.entries(env.variables).map(([key, value]) => `${key}=${value}`).join("\n"));
  }

  async function refresh(resetDraft = false): Promise<void> {
    const id = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await listManagedWorktrees(cwd);
      if (id === sequence.current) apply(next, resetDraft || !data);
    } catch (caught) {
      if (id === sequence.current) setError(errorMessage(caught));
    } finally {
      if (id === sequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh(true);
    return () => { sequence.current++; };
  }, [cwd]);

  async function save(): Promise<void> {
    if (!data || busy || loading) return;
    setBusy("save");
    setError("");
    try {
      const variables: Record<string, string> = {};
      for (const line of variablesText.split("\n").filter((line) => line.trim())) {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(variables, key)) throw new Error(t("Use one unique NAME=value environment variable per line."));
        variables[key] = line.slice(separator + 1);
      }
      if (!/^\d+$/.test(retainCount) || Number(retainCount) < 1 || Number(retainCount) > 100) throw new Error(t("Retain between 1 and 100 worktrees."));
      const draft: WorktreePolicy = { ...(rootDir.trim() ? { rootDir: rootDir.trim() } : {}), fetchBeforeCreate,
        autoCleanup, retainCount: Number(retainCount), confirmBeforeDelete, protectedOwners: data.policy.protectedOwners,
        environment: { ...environment, variables } };
      const response = await updateWorkspaceSettings(cwd, { worktreePolicy: draft });
      const policy = response.settings.worktreePolicy;
      if (!policy) throw new Error(t("Worktree settings were not saved."));
      apply({ ...data, policy });
      showToast({ message: t("Worktree settings saved"), tone: "success", scope: "settings:worktrees:save" });
      // The effective directory includes the daemon's workspace identity namespace.
      const next = await listManagedWorktrees(cwd);
      setData(next);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(""); }
  }

  async function perform(entry: Pick<ManagedWorktreeEntry, "ownerKind" | "ownerId">, action: ManagedWorktreeActionRequest["action"], snapshotId?: string): Promise<void> {
    if (busy || loading) return;
    setBusy(`${action}:${entry.ownerKind}:${entry.ownerId}`);
    if (action === "cleanup") setCleanupError(""); else setError("");
    try {
      const next = await actOnManagedWorktree(cwd, { ownerKind: entry.ownerKind, ownerId: entry.ownerId, action,
        ...(action === "cleanup" ? { confirmed: true } : {}), ...(snapshotId ? { snapshotId } : {}) });
      setData(next);
      if (action === "cleanup") {
        setCleanupTarget(undefined);
        showToast({ message: t("Worktree cleaned up"), tone: "success", scope: "settings:worktrees:cleanup" });
      }
    } catch (caught) {
      if (action === "cleanup" && cleanupTarget) setCleanupError(errorMessage(caught)); else setError(errorMessage(caught));
    } finally { setBusy(""); }
  }

  return { data, rootDir, setRootDir, fetchBeforeCreate, setFetchBeforeCreate, autoCleanup, setAutoCleanup, retainCount, setRetainCount,
    confirmBeforeDelete, setConfirmBeforeDelete, environment, setEnvironment, variablesText, setVariablesText, loading, busy, error, refresh, save, perform,
    cleanupTarget, cleanupError,
    requestCleanup: (entry: ManagedWorktreeEntry) => { setCleanupError(""); if (data?.policy.confirmBeforeDelete === false) void perform(entry, "cleanup"); else setCleanupTarget(entry); },
    closeCleanup: () => { if (!busy) setCleanupTarget(undefined); },
    dirty: Boolean(data && (rootDir.trim() !== (data.policy.rootDir ?? "") || fetchBeforeCreate !== data.policy.fetchBeforeCreate
      || autoCleanup !== (data.policy.autoCleanup ?? false) || retainCount !== String(data.policy.retainCount ?? 15)
      || confirmBeforeDelete !== (data.policy.confirmBeforeDelete ?? true)
      || JSON.stringify(environment) !== JSON.stringify(data.policy.environment ?? { enabled: false, setupScript: "", variables: {}, timeoutSeconds: 120 })
      || variablesText !== Object.entries(data.policy.environment?.variables ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"))),
  };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
