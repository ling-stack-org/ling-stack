import { Activity, Archive, ArchiveRestore, GitBranch, Pin, PinOff, Workflow } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, EmptyState, InlineFeedback } from "../../shared/ui/index.js";
import type { LingThread } from "../../types.js";
import type { WorkHistoryTurnLoadState } from "./runs-thread-types.js";
import { ThreadAttemptsSection } from "./ThreadAttemptsSection.js";
import { ThreadEvidenceSection } from "./ThreadEvidenceSection.js";
import { ThreadForkSection } from "./ThreadForkSection.js";
import { ThreadLineageSection } from "./ThreadLineageSection.js";
import { ThreadOverviewSection } from "./ThreadOverviewSection.js";
import { ThreadResumeSection } from "./ThreadResumeSection.js";
import { ThreadTechnicalDetails } from "./ThreadTechnicalDetails.js";
import { useThreadDetailController } from "./useThreadDetailController.js";

const threadLoadFailureIcon = <Workflow />;

export function ThreadDetailPanel({ cwd, thread, threadId, turnState, visibleThreads, isRunning, onRefresh, onSelectRun, onSelectThreadId }: {
  readonly cwd: string;
  readonly thread: LingThread | undefined;
  readonly threadId: string;
  readonly turnState?: WorkHistoryTurnLoadState;
  readonly visibleThreads: readonly LingThread[];
  readonly isRunning: boolean;
  readonly onRefresh: () => void;
  readonly onSelectRun: (runId: string) => void;
  readonly onSelectThreadId: (threadId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const controller = useThreadDetailController({ cwd, thread, threadId, turnState, visibleThreads, isRunning, onRefresh, onSelectThreadId });
  const { state, actions } = controller;
  const headerErrors = ["refresh", "fork", "pin", "unpin", "archive", "unarchive"]
    .map((key) => state.errors[key as keyof typeof state.errors]).filter(Boolean);
  if (state.evidenceState === "failed" && !state.displayThread) {
    return (
      <section className="runs-detail-workspace" aria-label={t("Thread detail")}>
        <EmptyState
          action={<Button onClick={() => void actions.loadEvidence()} size="sm">{t("Retry")}</Button>}
          description={state.errors.evidence}
          icon={threadLoadFailureIcon}
          title={t("Page failed to load")}
        />
      </section>
    );
  }
  return (
    <section className="runs-detail-workspace thread-detail-panel" aria-labelledby="thread-detail-title" aria-label={t("Thread detail")}>
      <header className="runs-detail-header">
        <div className="runs-detail-heading">
          <Workflow aria-hidden="true" size={18} />
          <span><h2 id="thread-detail-title">{t("Thread detail")}</h2><small>{state.displayThread?.title ?? threadId} · {t(state.displayThread?.status ?? "unknown")}</small></span>
        </div>
        <div className="runs-detail-actions">
          <Button disabled={!state.sourceRunId} leadingIcon={<Activity size={15} />} onClick={() => onSelectRun(state.sourceRunId)} size="sm">{t("Open source run")}</Button>
          <Button disabled={!state.canFork} leadingIcon={<GitBranch size={15} />} loading={state.busyActions.has("fork")} onClick={() => void actions.fork()} size="sm">{t("Fork")}</Button>
          <Button
            leadingIcon={state.isPinned ? <PinOff size={15} /> : <Pin size={15} />}
            loading={state.busyActions.has(state.isPinned ? "unpin" : "pin")}
            onClick={() => void actions.mutate(state.isPinned ? "unpin" : "pin")}
            size="sm"
          >{state.isPinned ? t("Unpin") : t("Pin")}</Button>
          <Button
            leadingIcon={state.isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            loading={state.busyActions.has(state.isArchived ? "unarchive" : "archive")}
            onClick={() => void actions.mutate(state.isArchived ? "unarchive" : "archive")}
            size="sm"
            variant={state.isArchived ? "secondary" : "danger"}
          >{state.isArchived ? t("Unarchive") : t("Archive")}</Button>
        </div>
      </header>
      <div className="runs-detail-sections">
        {state.evidenceState === "stale" ? <InlineFeedback tone="warning" title={t("Some information may be out of date. Reconnect to continue.")}>{state.errors.evidence}</InlineFeedback> : null}
        {headerErrors.map((error, index) => <InlineFeedback key={`${index}:${error}`} tone="danger">{error}</InlineFeedback>)}
        {state.hasActiveNonTerminalRun ? <InlineFeedback tone="warning">{t("Thread has an active run; resume is disabled until it reaches a terminal state.")}</InlineFeedback> : null}
        <ThreadOverviewSection controller={controller} />
        <ThreadLineageSection controller={controller} onSelectThreadId={onSelectThreadId} />
        <ThreadAttemptsSection controller={controller} onSelectRun={onSelectRun} />
        <ThreadEvidenceSection controller={controller} />
        <ThreadResumeSection controller={controller} />
        <ThreadForkSection controller={controller} />
        <ThreadTechnicalDetails controller={controller} />
      </div>
    </section>
  );
}

export type ThreadDetailController = ReturnType<typeof useThreadDetailController>;
