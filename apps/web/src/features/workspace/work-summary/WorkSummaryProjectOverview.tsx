import { useState } from "react";
import { Folder, Plus, RefreshCw } from "lucide-react";
import { daemonClient } from "../../../api/client.js";
import { useI18n } from "../../../i18n.js";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, IconButton, Input } from "../../../shared/ui/index.js";
import { WorkSummaryGroup } from "./WorkSummaryGroup.js";
import { WorkSummaryPullRequestRow } from "./WorkSummaryPullRequestRow.js";
import { buildWorkSummaryGroups, summaryFolderLabel } from "./work-summary-model.js";
import type { WorkSummaryResponse, WorkSummarySession } from "./work-summary.types.js";

interface WorkSummaryProjectOverviewProps {
  readonly cwd: string;
  readonly data?: WorkSummaryResponse;
  readonly error?: string;
  readonly loading: boolean;
  readonly currentWorkspaceKey?: string;
  readonly onRefresh: () => Promise<void>;
  readonly onOpenChanges?: (cwd: string) => void;
  readonly onOpenSession: (session: WorkSummarySession) => void;
}

export function WorkSummaryProjectOverview({
  cwd,
  data,
  error,
  loading,
  currentWorkspaceKey,
  onRefresh,
  onOpenChanges,
  onOpenSession,
}: WorkSummaryProjectOverviewProps): React.JSX.Element {
  const { locale, t } = useI18n();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const groups = data ? buildWorkSummaryGroups(data) : [];
  const expandedGroup = groups.find((group) => group.workspace && group.workspace.key === currentWorkspaceKey)
    ?? groups.find((group) => group.workspace)
    ?? groups[0];
  const workspaceCount = groups.filter((group) => group.workspace).length;
  const pullRequestsLabel = t("Linked pull requests");

  async function updatePullRequest(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMutationError("");
    try {
      await action();
      await onRefresh();
    } catch (reason) {
      setMutationError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="work-summary-project-header">
        <Folder size={15} aria-hidden="true" />
        <div className="work-summary-project-copy" title={cwd}>
          <strong>{summaryFolderLabel(cwd)}</strong>
          {data ? (
            <small>
              {workspaceCount === 1 ? t("1 workspace") : t("{count} workspaces", { count: workspaceCount })}
              {" · "}
              {data.sessions.length === 1 ? t("1 session") : t("{count} sessions", { count: data.sessions.length })}
            </small>
          ) : null}
        </div>
        <IconButton icon={RefreshCw} label={t("Refresh work summary")} size="sm" loading={loading} disabled={loading} onClick={() => void onRefresh()} />
      </header>
      {data ? <small className="work-summary-time">{t("Updated")} {new Date(data.checkedAt).toLocaleTimeString(locale)}</small> : null}
      {error ? <p role="status" className="work-summary-note">{data ? t("Refresh failed; showing last available data") : t("Unable to load project overview")}</p> : null}
      {loading && !data ? <p role="status" className="work-summary-note">{t("Loading")}</p> : null}
      {groups.length > 0 ? (
        <div className="work-summary-groups">
          {groups.map((group) => (
            <WorkSummaryGroup
              key={group.id}
              group={group}
              defaultOpen={group.id === expandedGroup?.id}
              onOpenSession={onOpenSession}
              onOpenChanges={onOpenChanges}
            />
          ))}
        </div>
      ) : data ? <p className="work-summary-note">{t("No sessions in this project yet")}</p> : null}
      {data?.truncated ? <p className="work-summary-note">{t("Showing a limited summary of this project")}</p> : null}
      <section className="work-summary-pulls" aria-label={pullRequestsLabel}>
        <Collapsible>
          <div className="work-summary-pr-header">
            <h3>{pullRequestsLabel}</h3>
            <CollapsibleTrigger asChild>
              <IconButton icon={Plus} label={t("Link a pull request")} size="sm" disabled={busy} />
            </CollapsibleTrigger>
          </div>
          {data?.pullRequests.map((pull) => (
            <WorkSummaryPullRequestRow
              key={pull.url}
              pull={pull}
              busy={busy}
              onDetach={() => void updatePullRequest(() => daemonClient.detachWorkSummaryPullRequest(cwd, pull.url))}
            />
          ))}
          <CollapsibleContent>
            <form className="work-summary-pr-form" onSubmit={(event) => {
              event.preventDefault();
              if (url.trim()) {
                void updatePullRequest(async () => {
                  await daemonClient.attachWorkSummaryPullRequest(cwd, url.trim());
                  setUrl("");
                });
              }
            }}>
              <Input value={url} onChange={(event) => setUrl(event.target.value)} aria-label={t("Pull request URL")} placeholder="https://github.com/owner/repo/pull/123" disabled={busy} />
              <Button type="submit" size="sm" disabled={busy || !url.trim()}>{t("Attach")}</Button>
            </form>
          </CollapsibleContent>
          {mutationError ? <p className="work-summary-note" role="alert">{mutationError}</p> : null}
        </Collapsible>
      </section>
    </>
  );
}
