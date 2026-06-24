import { useEffect, useMemo, useState } from "react";
import { CircleAlert, FileCode2, Loader2 } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { summarizeFileChanges, type ConversationFileChange, type ConversationFileChangeStatus } from "../../../lib/diff-summary.js";
import { deriveFileChangeArtifacts, parseFileChangeArtifact } from "../../../lib/file-change-evidence.js";
import type { PreviewContentResponse, RunArtifact } from "../../../types.js";
import { DiffFileSummary } from "./DiffFileSummary.js";
import { DiffViewer } from "./DiffViewer.js";

export type ArtifactContentPreviewLoader = (cwd: string, artifactId: string, maxBytes?: number) => Promise<PreviewContentResponse>;

export interface FileChangeEvidencePanelProps {
  readonly cwd: string;
  readonly artifacts: readonly RunArtifact[];
  readonly status: ConversationFileChangeStatus;
  readonly loadArtifactPreview: ArtifactContentPreviewLoader;
  readonly sourceRunId?: string;
  readonly approvalId?: string;
  readonly compact?: boolean;
}

export function FileChangeEvidencePanel({
  cwd,
  artifacts,
  status,
  loadArtifactPreview,
  sourceRunId,
  approvalId,
  compact = false,
}: FileChangeEvidencePanelProps): JSX.Element | null {
  const { t } = useI18n();
  const diffArtifacts = useMemo(() => deriveFileChangeArtifacts(artifacts), [artifacts]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [changes, setChanges] = useState<readonly ConversationFileChange[]>([]);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    setExpanded(false);
    setLoading(false);
    setError("");
    setChanges([]);
    setSelectedId("");
  }, [cwd, diffArtifacts.map((artifact) => artifact.id).join("|"), status, sourceRunId, approvalId]);

  useEffect(() => {
    if (!expanded || diffArtifacts.length === 0 || changes.length > 0 || loading) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    void Promise.all(diffArtifacts.map(async (artifact) => {
      const preview = await loadArtifactPreview(cwd, artifact.id);
      return preview.text
        ? parseFileChangeArtifact({ artifact, diff: preview.text, status, sourceRunId, approvalId })
        : [];
    })).then((items) => {
      if (cancelled) {
        return;
      }
      const nextChanges = items.flat();
      setChanges(nextChanges);
      setSelectedId(nextChanges[0]?.id ?? "");
    }, (reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [approvalId, changes.length, cwd, diffArtifacts, expanded, loadArtifactPreview, loading, sourceRunId, status]);

  if (diffArtifacts.length === 0 || !cwd) {
    return null;
  }

  const summary = summarizeFileChanges(changes);
  const fileCount = summary.fileCount || diffArtifacts.length;
  const selected = changes.find((change) => change.id === selectedId) ?? changes[0];

  return (
    <details
      className={compact ? "file-change-evidence compact" : "file-change-evidence"}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>
          <FileCode2 size={14} />
          <strong>{t("Changed {count} files", { count: fileCount })}</strong>
        </span>
        {changes.length > 0 ? (
          <small>
            {t("{count} additions", { count: summary.additions })}
            {" · "}
            {t("{count} deletions", { count: summary.deletions })}
          </small>
        ) : <small>{t("Diff evidence")}</small>}
      </summary>

      {loading ? (
        <div className="file-change-loading">
          <Loader2 className="spin" size={14} />
          <span>{t("Loading preview...")}</span>
        </div>
      ) : null}
      {error ? (
        <div className="file-change-error" role="alert">
          <CircleAlert size={14} />
          <span>{t("Preview unavailable")}: {error}</span>
        </div>
      ) : null}
      {changes.length > 0 ? (
        <div className="file-change-body">
          <div className="diff-file-list" aria-label={t("Changed files")}>
            {changes.map((change) => (
              <DiffFileSummary
                key={change.id}
                change={change}
                selected={change.id === selected?.id}
                onSelect={() => setSelectedId(change.id)}
              />
            ))}
          </div>
          {selected ? <DiffViewer change={selected} /> : null}
        </div>
      ) : null}
    </details>
  );
}
