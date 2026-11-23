import { useEffect, useState } from "react";
import type { WorkspaceFileCapabilityChangeResponse, WorkspaceFileCapabilityScope } from "@ling-stack/contracts";
import { getWorkspaceFileCapabilityChanges } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import { DiffViewer } from "../../../shared/conversation/blocks/DiffViewer.js";

export function WorkspaceFileScopedChanges({ cwd, capabilityId, scope }: {
  readonly cwd: string; readonly capabilityId: string; readonly scope: WorkspaceFileCapabilityScope;
}): React.JSX.Element {
  const { t } = useI18n();
  const key = JSON.stringify([cwd, capabilityId, scope]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; response?: WorkspaceFileCapabilityChangeResponse; error?: string }>({ key });
  useEffect(() => {
    let cancelled = false;
    setState({ key });
    void getWorkspaceFileCapabilityChanges({ cwd, capabilityId, scope }).then(response => {
      if (!cancelled) setState({ key, response });
    }, error => { if (!cancelled) setState({ key, error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  // `key` includes the complete capability scope, without depending on object identity.
  }, [cwd, capabilityId, key, attempt]);
  if (state.key !== key || !state.response && !state.error) return <div className="artifact-preview-loading" role="status">{t("Loading")}</div>;
  if (state.error) return <div className="artifact-preview-error" role="alert">{state.error} <button type="button" onClick={() => setAttempt(value => value + 1)}>{t("Retry")}</button></div>;
  const result = state.response!;
  if (result.state !== "exact") return <div className="artifact-preview-empty" title={result.unavailableReason}>{t("Historical diff unavailable")}</div>;
  if (!result.file) return <div className="artifact-preview-empty">{t("No changes")}</div>;
  const file = result.file;
  const kind = file.kind === "deleted" ? "delete" : file.kind === "added" ? "add" : "update";
  return <div className="workspace-file-changes" data-workspace-file-change-path={file.path}>
    <div className="workspace-file-changes-summary"><span>{t("This work's changes")}</span>
      {file.additions !== undefined && file.deletions !== undefined ? <span className="workspace-change-stats"><span className="add">+{file.additions}</span><span className="delete">−{file.deletions}</span></span> : null}
    </div>
    {file.diff ? <DiffViewer revision={result.revision} change={{ id: file.id, path: file.path, kind, status: "completed", diff: file.diff }} /> : <div className="artifact-preview-empty">{t("Diff unavailable")}</div>}
  </div>;
}
