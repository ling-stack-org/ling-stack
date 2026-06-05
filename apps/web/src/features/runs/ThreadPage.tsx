import { LingDaemonError } from "@ling-stack/api-client";
import { CircleAlert, Loader2, RefreshCw, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listLingThreads } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { StatusBadge } from "../../shared/components/index.js";
import type { LingThread } from "../../types.js";
import { ThreadDetailPanel } from "./RunHistory.js";

export function ThreadPage({
  cwd,
  isRunning,
  onRefreshRuns,
  onSelectRun,
}: {
  readonly cwd: string;
  readonly isRunning: boolean;
  readonly onRefreshRuns: () => void;
  readonly onSelectRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [threads, setThreads] = useState<readonly LingThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? threads[0],
    [selectedThreadId, threads],
  );

  async function refreshThreads(): Promise<void> {
    if (!cwd.trim()) {
      setThreads([]);
      setSelectedThreadId("");
      setErrorMessage("");
      return;
    }
    setLoading(true);
    setErrorMessage("");
    try {
      const response = await listLingThreads(cwd, { limit: 100 });
      setThreads(response.threads);
      setSelectedThreadId((current) =>
        current && response.threads.some((thread) => thread.id === current)
          ? current
          : response.threads[0]?.id ?? "",
      );
    } catch (error) {
      if (error instanceof LingDaemonError && error.status === 404) {
        setThreads([]);
        setSelectedThreadId("");
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  function refreshThreadAndRuns(): void {
    onRefreshRuns();
    void refreshThreads();
  }

  useEffect(() => {
    void refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  return (
    <div className="run-history-layout thread-page-layout">
      <section className="panel runs-panel" aria-labelledby="thread-page-title">
        <div className="panel-title split">
          <span>
            <Workflow size={18} />
            <h2 id="thread-page-title">{t("Threads")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={() => void refreshThreads()} disabled={loading}>
            {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="runs-list thread-list">
          {threads.length === 0 ? (
            <div className="empty-state compact-empty">
              {loading ? <Loader2 className="spin" /> : <Workflow />}
              <span>{loading ? t("Loading threads...") : t("No threads yet")}</span>
            </div>
          ) : (
            threads.map((thread) => (
              <button
                key={thread.id}
                className={thread.id === selectedThread?.id ? "run-list-row selected" : "run-list-row"}
                type="button"
                onClick={() => setSelectedThreadId(thread.id)}
              >
                <span className={`status-dot ${thread.status}`} />
                <span className="run-list-main">
                  <strong>{thread.title}</strong>
                  <small>{thread.kind} · {thread.objective}</small>
                </span>
                <span className="run-list-meta">
                  <StatusBadge status={thread.status} />
                  <time>{formatDateTime(thread.updatedAt)}</time>
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      {selectedThread ? (
        <ThreadDetailPanel
          cwd={cwd}
          thread={selectedThread}
          threadId={selectedThread.id}
          isRunning={isRunning}
          onRefresh={refreshThreadAndRuns}
          onSelectRun={onSelectRun}
        />
      ) : (
        <section className="panel run-detail-panel thread-detail-panel" aria-label={t("Thread detail")}>
          <div className="empty-state">
            <Workflow />
            <span>{t("Select a thread to inspect evidence, actions, lineage, and resume context.")}</span>
          </div>
        </section>
      )}
    </div>
  );
}
