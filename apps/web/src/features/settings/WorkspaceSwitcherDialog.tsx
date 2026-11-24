import { useEffect, useState } from "react";
import type { RegisteredWorkspaceSummary } from "@ling-stack/contracts";
import { listRegisteredWorkspaces, selectWorkspaceDirectory } from "../../api/workspace-directory.js";
import { useI18n } from "../../i18n.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, InlineFeedback, Skeleton } from "../../shared/ui/index.js";

export function WorkspaceSwitcherDialog({ cwd, open, onClose, onSelect }: {
  readonly cwd: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (cwd: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [workspaces, setWorkspaces] = useState<readonly RegisteredWorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError("");
    void listRegisteredWorkspaces().then(result => {
      if (current) setWorkspaces(result.workspaces);
    }).catch(caught => {
      if (current) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open]);

  async function chooseFolder(): Promise<void> {
    setChoosing(true);
    setError("");
    try {
      const selected = await selectWorkspaceDirectory(cwd, true);
      if (!selected.cancelled) onSelect(selected.path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setChoosing(false); }
  }

  return <Dialog open={open} busy={choosing} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent size="md">
      <DialogHeader title={t("Switch workspace")} closeLabel={t("Close")} />
      <DialogBody>
        {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
        {loading ? <Skeleton height={120} /> : <div className="settings-workspaces-list">
          {workspaces.map(item => <Button key={item.workspaceId} className="settings-workspaces-choice" variant="ghost"
            disabled={!item.available || item.cwd === cwd} onClick={() => onSelect(item.cwd)}
            aria-current={item.cwd === cwd ? "true" : undefined}>
            <span><strong>{item.name}</strong><small>{item.cwd}</small></span>
            <span>{item.cwd === cwd ? t("Current workspace") : item.available ? "" : t("Unavailable")}</span>
          </Button>)}
        </div>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="ghost" loading={choosing} disabled={loading} onClick={() => void chooseFolder()}>{t("Select folder")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
