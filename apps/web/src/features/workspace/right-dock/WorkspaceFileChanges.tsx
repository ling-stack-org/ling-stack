import { useEffect, useState } from "react";
import type { WorkspaceChangesResponse } from "@ling-stack/contracts";
import { getWorkspaceChanges } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import { DiffViewer } from "../../../shared/conversation/blocks/DiffViewer.js";
import { workspaceFileChange, workspaceRelativePath } from "./workspace-file-change.js";

export function WorkspaceFileChanges({ cwd, path }: { readonly cwd: string; readonly path: string }): React.JSX.Element {
  const { t } = useI18n();
  const key = JSON.stringify([cwd, path]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; response?: WorkspaceChangesResponse; error?: string }>({ key });
  useEffect(() => {
    let cancelled = false;
    setState({ key });
    void getWorkspaceChanges(cwd).then(response => {
      if (!cancelled) setState({ key, response });
    }, error => { if (!cancelled) setState({ key, error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  }, [cwd, key, attempt]);
  if (state.key !== key || !state.response && !state.error) return <div className="artifact-preview-loading" role="status">{t("Loading")}</div>;
  if (state.error) return <div className="artifact-preview-error" role="alert">{state.error} <button type="button" onClick={() => setAttempt(value => value + 1)}>{t("Retry")}</button></div>;
  const response = state.response!;
  if (response.state === "not_git_repo") return <div className="artifact-preview-empty">{t("Not a Git repository")}</div>;
  if (response.state === "unavailable" || response.state === "error" || !workspaceRelativePath(response, cwd, path)) {
    return <div className="artifact-preview-error" role="alert">{response.errorMessage || response.unavailableReason || t("Diff unavailable")}</div>;
  }
  const file = workspaceFileChange(response, cwd, path);
  if (!file) return <div className="artifact-preview-empty">{response.truncated ? t("Preview truncated") : t("No changes")}</div>;
  const kind = file.kind === "deleted" ? "delete" : file.kind === "renamed" ? "rename" : file.kind === "added" || file.untracked ? "add" : "update";
  return <div className="workspace-file-changes" data-workspace-file-change-path={file.path}>
    <div className="workspace-file-changes-summary"><span>{t("Workspace changes")}</span>
      {file.staged ? <span>{t("Staged")}</span> : null}{file.unstaged ? <span>{t("Unstaged")}</span> : null}{file.untracked ? <span>{t("Untracked")}</span> : null}
      <span className="workspace-change-stats"><span className="add">+{file.additions}</span><span className="delete">−{file.deletions}</span></span>
    </div>
    {file.layers ? file.layers.map(layer => <div key={layer.kind}><div className="workspace-file-changes-summary">{t(layer.kind === "staged" ? "Staged" : "Unstaged")}</div>{layer.diff ? <DiffViewer change={{ id: `file:${file.path}:${layer.kind}`, path: file.path, kind, status: "completed", diff: layer.diff }} /> : <div className="artifact-preview-empty">{t("Diff unavailable")}</div>}{layer.truncated ? <div>{t("Preview truncated")}</div> : null}</div>) : file.diff ? <DiffViewer change={{ id: `file:${file.path}`, path: file.path, kind, status: "completed", diff: file.diff }} /> : <div className="artifact-preview-empty">{t("Diff unavailable")}</div>}
    {file.truncated ? <div className="artifact-preview-empty">{t("Preview truncated")}</div> : null}
  </div>;
}
