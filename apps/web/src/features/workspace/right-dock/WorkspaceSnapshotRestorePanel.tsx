import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ChevronDown, RotateCcw } from "lucide-react";
import type {
  SnapshotRestoreRequest,
  WorkspaceSnapshotManifest,
  WorkspaceSnapshotPreview,
  WorkspaceSnapshotPreviewEntry,
} from "@ling-stack/contracts";
import {
  confirmWorkspaceSnapshotRestore,
  createWorkspaceSnapshot,
  createWorkspaceSnapshotAnchor,
  createWorkspaceSnapshotConfirmation,
  getWorkspaceSnapshot,
  getWorkspaceSnapshotRestore,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
} from "../../../api/workspace-changes.js";
import { useI18n } from "../../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  IconButton,
  InlineFeedback,
} from "../../../shared/ui/index.js";

export function WorkspaceSnapshotRestorePanel({ cwd }: { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  const [snapshots, setSnapshots] = useState<readonly WorkspaceSnapshotManifest[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [selected, setSelected] = useState<WorkspaceSnapshotPreview>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [restore, setRestore] = useState<SnapshotRestoreRequest>();
  const [expanded, setExpanded] = useState(false);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);

  async function refresh(): Promise<void> {
    const result = await listWorkspaceSnapshots(cwd);
    setSnapshots(result.snapshots);
    setEnabled(result.restoreUiEnabled === true);
  }

  useEffect(() => {
    let cancelled = false;
    void listWorkspaceSnapshots(cwd).then((result) => {
      if (!cancelled) {
        setSnapshots(result.snapshots);
        setEnabled(result.restoreUiEnabled === true);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cwd]);

  async function createSnapshot(): Promise<void> {
    if (busy) return;
    setBusy(true); setMessage(undefined);
    try {
      const result = await createWorkspaceSnapshot(cwd);
      await refresh();
      setMessage(result.manifest.state === "committed" ? t("Restore point created") : t("Restore point unavailable"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  async function openPreview(snapshot: WorkspaceSnapshotManifest, trigger: HTMLButtonElement): Promise<void> {
    returnFocusRef.current = trigger;
    setBusy(true); setMessage(undefined);
    try {
      setSelected(await getWorkspaceSnapshot(cwd, snapshot.id));
      setDialogOpen(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  async function confirmRestore(): Promise<void> {
    if (!selected || busy) return;
    setBusy(true); setMessage(undefined);
    try {
      // The anchor and confirmation are durable records. The restore RPC is
      // only called after both records have been created and explicitly confirmed.
      const anchor = await createWorkspaceSnapshotAnchor(cwd, selected.manifest.id);
      const pending = await createWorkspaceSnapshotConfirmation(cwd, selected.manifest.id, anchor.id);
      const confirmation = await confirmWorkspaceSnapshotRestore(cwd, pending.id);
      if (confirmation.state !== "confirmed") throw new Error(t("Restore confirmation was not accepted"));
      const idempotencyKey = `web-snapshot-restore-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
      const request = await restoreWorkspaceSnapshot(cwd, selected.manifest.id, {
        idempotencyKey,
        anchorId: anchor.id,
        confirmationId: confirmation.id,
        expectedWorkspaceFingerprint: anchor.expectedWorkspaceFingerprint,
        expectedProvenanceWatermark: anchor.expectedProvenanceWatermark,
      });
      setRestore(request);
      if (request.state === "committed") {
        setMessage(t("Workspace restored; conversation history is unchanged"));
        setDialogOpen(false);
        await refresh();
      } else {
        await pollRestore(request.id);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  async function pollRestore(requestId: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const current = await getWorkspaceSnapshotRestore(cwd, requestId);
      setRestore(current);
      if (["committed", "failed", "conflict", "expired", "recovery_required"].includes(current.state)) {
        setMessage(current.state === "committed" ? t("Workspace restored; conversation history is unchanged") : current.lastError ?? t("Restore requires review"));
        if (current.state === "committed") { setDialogOpen(false); await refresh(); }
        return;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    setMessage(t("Restore is still running; reopen this panel to inspect durable progress"));
  }

  const previewOperations = useMemo(() => groupOperations(selected?.operations ?? []), [selected]);

  if (!enabled) return <></>;
  return (
    <section className="workspace-snapshot-restore-panel" aria-label={t("Workspace restore points")}>
      <header className="workspace-snapshot-restore-head">
        <span><strong>{t("Restore points")}</strong><small>{t("Workspace files only; conversation history is unchanged")}</small></span>
        <IconButton icon={Camera} label={t("Create restore point")} loading={busy} onClick={() => void createSnapshot()} size="sm" />
      </header>
      {message ? <InlineFeedback tone="neutral">{message}</InlineFeedback> : null}
      {restore && restore.state !== "committed" ? <div className="workspace-snapshot-restore-progress" role="status"><strong>{t("Restore progress")}</strong><span>{restore.state}</span><small>{restore.journalEntryCount} {t("journal entries")}</small></div> : null}
      {snapshots.length > 0 ? (
        <ul className="workspace-snapshot-restore-list">
          {snapshots.slice(0, 8).map((snapshot) => (
            <li key={snapshot.id}>
              <span className="workspace-snapshot-restore-copy"><strong>{new Date(snapshot.createdAt).toLocaleString()}</strong><small>{snapshot.managedEntryCount ?? snapshot.entryCount} {t("managed entries")} · {snapshot.excludedEntryCount ?? 0} {t("excluded")}{snapshot.expiresAt ? ` · ${t("expires")} ${new Date(snapshot.expiresAt).toLocaleDateString()}` : ""}</small></span>
              <Button ref={returnFocusRef} variant="secondary" size="sm" loading={busy} onClick={(event) => void openPreview(snapshot, event.currentTarget)}>{t("Review")}</Button>
            </li>
          ))}
        </ul>
      ) : <small className="workspace-snapshot-restore-empty">{t("No restore points")}</small>}

      {selected ? (
        <Dialog open={dialogOpen} busy={busy} onOpenChange={(open) => { if (!busy) setDialogOpen(open); }}>
          <DialogContent className="workspace-snapshot-restore-dialog" size="lg" aria-label={t("Review workspace restore") }>
            <DialogHeader title={t("Review workspace restore")} closeLabel={t("Close")} description={t("This changes workspace files, not conversation history.")} />
            <DialogBody>
              <div className="workspace-snapshot-restore-meta"><span>{t("Captured")} {new Date(selected.manifest.createdAt).toLocaleString()}</span><span>{selected.manifest.captureKind}</span><span>{selected.manifest.managedEntryCount ?? selected.manifest.entryCount} {t("managed paths")}</span><span>{selected.manifest.excludedEntryCount ?? 0} {t("excluded")}</span></div>
              <div className={`workspace-snapshot-fingerprint ${selected.fingerprintStatus}`}><strong>{t("Current fingerprint")}</strong><span>{selected.fingerprintStatus === "matching" ? t("matches snapshot") : t("has changed; restore will compare again before writing")}</span></div>
              {(["create", "update", "delete", "unchanged"] as const).map((operation) => previewOperations[operation]?.length ? <PreviewGroup key={operation} operation={operation} entries={previewOperations[operation]} expanded={expanded} onToggle={() => setExpanded((value) => !value)} /> : null)}
              {selected.entries.some((entry) => !entry.managed) ? <div className="workspace-snapshot-excluded"><strong>{t("Excluded paths are never changed")}</strong><small>{selected.entries.filter((entry) => !entry.managed).map((entry) => `${entry.relativePath} (${entry.exclusionReason ?? "unsupported"})`).join(" · ")}</small></div> : null}
            </DialogBody>
            <DialogFooter>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialogOpen(false)}>{t("Cancel")}</Button>
              <Button leadingIcon={<RotateCcw size={14} />} size="sm" variant="danger" loading={busy} loadingLabel={t("Restoring")} onClick={() => void confirmRestore()}>{t("Restore snapshot")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

function groupOperations(entries: readonly WorkspaceSnapshotPreviewEntry[]): Record<string, readonly WorkspaceSnapshotPreviewEntry[]> {
  return entries.reduce<Record<string, WorkspaceSnapshotPreviewEntry[]>>((groups, entry) => {
    (groups[entry.operation] ??= []).push(entry);
    return groups;
  }, {});
}

function PreviewGroup({ operation, entries, expanded, onToggle }: { readonly operation: "create" | "update" | "delete" | "unchanged"; readonly entries: readonly WorkspaceSnapshotPreviewEntry[]; readonly expanded: boolean; readonly onToggle: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const labels: Record<typeof operation, string> = { create: t("Create"), update: t("Update"), delete: t("Delete"), unchanged: t("Unchanged") };
  return <section className="workspace-snapshot-preview-group"><button type="button" onClick={onToggle}><span>{labels[operation]} · {entries.length}</span><ChevronDown className={expanded ? "expanded" : ""} size={14} /></button>{expanded ? <ul>{entries.slice(0, 80).map((entry) => <li key={entry.relativePath}>{entry.relativePath}</li>)}</ul> : null}</section>;
}
