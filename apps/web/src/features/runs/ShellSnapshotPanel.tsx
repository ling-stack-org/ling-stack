import { RefreshCw, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { artifactContentUrl, listRunShellSnapshots } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { truncatePreview } from "../../lib/data.js";
import { Button, DataRow, EmptyState, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import type { RunArtifact, RunSession, ShellSnapshotListItem } from "../../types.js";
import { runStatusTone } from "./run-list-view-models.js";

export function ShellSnapshotPanel({ cwd, run, artifacts }: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly artifacts: readonly RunArtifact[];
}): JSX.Element {
  const { t } = useI18n();
  const [snapshots, setSnapshots] = useState<readonly ShellSnapshotListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const identityRef = useRef("");
  const revisionRef = useRef(0);
  identityRef.current = `${cwd.trim()}::${run.id}`;
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));

  useEffect(() => {
    revisionRef.current += 1;
    setSnapshots([]);
    setError("");
    void load(false);
    // identity reset owns initial request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, run.id]);

  async function load(retain = true): Promise<void> {
    const identity = `${cwd.trim()}::${run.id}`;
    const revision = ++revisionRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await listRunShellSnapshots(run.id, cwd);
      if (identityRef.current !== identity || revisionRef.current !== revision) return;
      setSnapshots(response.snapshots);
    } catch (caught) {
      if (identityRef.current !== identity || revisionRef.current !== revision) return;
      if (!retain) setSnapshots([]);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (identityRef.current === identity && revisionRef.current === revision) setLoading(false);
    }
  }

  return (
    <section className="runs-subsection shell-snapshot-panel">
      <h4><SquareTerminal size={15} />{t("Shell snapshots")} <small>{t("{count} snapshots", { count: snapshots.length })}</small></h4>
      {error ? (
        <InlineFeedback title={t("Shell snapshot diagnostics unavailable")} tone="warning">
          <span>{error}</span>
          <Button leadingIcon={<RefreshCw size={13} />} loading={loading} onClick={() => void load()} size="sm">{t("Retry")}</Button>
        </InlineFeedback>
      ) : null}
      {!loading && snapshots.length === 0 && !error ? <EmptyState compact icon={<SquareTerminal />} title={t("No shell snapshots recorded for this run")} description={t("Approved bash commands will record redacted start and terminal snapshots when the daemon feature is enabled.")} /> : null}
      <div className="runs-snapshot-list">
        {snapshots.map((snapshot) => (
          <DataRow
            actions={<span className="runs-row-actions"><SnapshotLink artifact={artifactsById.get(snapshot.artifactId)} artifactId={snapshot.artifactId} cwd={cwd} label={t("JSON")} />{snapshot.textArtifactId ? <SnapshotLink artifact={artifactsById.get(snapshot.textArtifactId)} artifactId={snapshot.textArtifactId} cwd={cwd} label={t("Text")} /> : null}</span>}
            identity={<span><strong>{truncatePreview(snapshot.commandPreview, 180)}</strong><small>{t("Tool call")}: {snapshot.toolCallId}</small></span>}
            key={snapshot.id}
            loading={loading}
            status={<span><StatusIndicator compact label={t(snapshot.status)} tone={runStatusTone(snapshot.status)} /><small>#{snapshot.sequence} · {formatDateTime(snapshot.createdAt)}</small><small>{t("Exit code")}: {snapshot.exitCode ?? "-"} · {t("Duration")}: {snapshot.durationMs === undefined ? "-" : `${snapshot.durationMs}ms`}</small></span>}
          />
        ))}
      </div>
    </section>
  );
}

function SnapshotLink({ cwd, label, artifactId, artifact }: { readonly cwd: string; readonly label: string; readonly artifactId: string; readonly artifact?: RunArtifact }): JSX.Element {
  return <a className="runs-artifact-link" href={artifactContentUrl(artifactId, cwd)} rel="noreferrer" target="_blank" title={artifact?.title ?? artifactId}>{label}</a>;
}
