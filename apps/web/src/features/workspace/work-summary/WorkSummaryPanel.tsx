import { useEffect, useRef, useState, type ReactNode } from "react";
import { GitPullRequest, RefreshCw } from "lucide-react";
import { daemonClient } from "../../../api/client.js";
import { useI18n } from "../../../i18n.js";
import { Button, IconButton, Input } from "../../../shared/ui/index.js";
import { WorkSummaryGroup } from "./WorkSummaryGroup.js";
import { WorkSummaryPullRequestRow } from "./WorkSummaryPullRequestRow.js";
import { buildWorkSummaryGroups } from "./work-summary-model.js";
import { useWorkSummary } from "./useWorkSummary.js";
import { useWorkSummaryContext } from "./WorkSummaryProvider.js";

export function WorkSummaryPanel({ visible, onClose, onOpenChanges, children }: {
  readonly onOpenChanges: (cwd: string) => void;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const context = useWorkSummaryContext();
  return context ? <ProjectWorkSummary key={context.cwd} visible={visible} onClose={onClose} onOpenChanges={onOpenChanges}>{children}</ProjectWorkSummary> : children;
}

function ProjectWorkSummary({ visible, onClose, onOpenChanges, children }: {
  readonly onOpenChanges: (cwd: string) => void;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  const context = useWorkSummaryContext()!;
  const { cwd, rememberTrigger, restoreFocus } = context;
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const summary = useWorkSummary(cwd, visible);
  const mounted = useRef(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    rememberTrigger();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
      restoreFocus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [visible, rememberTrigger, restoreFocus]);

  async function mutatePullRequest(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMutationError("");
    try {
      await action();
      if (!mounted.current) return;
      setUrl("");
      await summary.refresh();
    } catch (error) {
      if (mounted.current) setMutationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="work-summary-panel" aria-label={t("Work summary")}>
    <header className="work-summary-head">
      <strong>{t("Work summary")}</strong>
      <IconButton icon={RefreshCw} label={t("Refresh work summary")} size="sm" loading={summary.loading} disabled={summary.loading} onClick={() => void summary.refresh()} />
    </header>
    {summary.data ? <small className="work-summary-time">{t("Updated")} {new Date(summary.data.checkedAt).toLocaleTimeString()}</small> : null}
    {summary.error ? <p role="status" className="work-summary-note">{t("Refresh failed; showing last available data")}</p> : null}
    {summary.loading && !summary.data ? <p className="work-summary-note">{t("Loading")}</p> : null}
    <div className="work-summary-context">{children}</div>
    <div className="work-summary-groups">
      {summary.data ? buildWorkSummaryGroups(summary.data).map((group) => <WorkSummaryGroup key={group.id} group={group}
        onOpenSession={(session) => { onClose(); context.onOpenSession(session); }}
        onOpenChanges={(workspace) => { onOpenChanges(workspace.cwd); onClose(); }} />) : null}
      {summary.data?.sessions.length === 0 ? <p className="work-summary-note">{t("No sessions in this project yet")}</p> : null}
      {summary.data?.truncated ? <p className="work-summary-note">{t("Showing a limited summary of this project")}</p> : null}
    </div>
    <section className="work-summary-pulls" aria-label={t("Pull requests")}>
      <strong><GitPullRequest size={15} aria-hidden="true" />{t("Pull requests")}</strong>
      {summary.data?.pullRequests.map((pull) => <WorkSummaryPullRequestRow key={pull.url} pull={pull} busy={busy}
        onDetach={() => void mutatePullRequest(() => daemonClient.detachWorkSummaryPullRequest(cwd, pull.url))} />)}
      <form className="work-summary-pr-form" onSubmit={(event) => {
        event.preventDefault();
        if (url.trim()) void mutatePullRequest(() => daemonClient.attachWorkSummaryPullRequest(cwd, url.trim()));
      }}>
        <Input value={url} onChange={(event) => setUrl(event.target.value)} aria-label={t("Pull request URL")} placeholder="https://github.com/owner/repo/pull/123" disabled={busy} />
        <Button type="submit" size="sm" disabled={busy || !url.trim()}>{t("Attach")}</Button>
      </form>
      {mutationError ? <p className="work-summary-note" role="alert">{mutationError}</p> : null}
    </section>
  </section>;
}
