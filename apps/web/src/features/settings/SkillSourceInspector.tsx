import { Archive, RotateCcw, Search } from "lucide-react";
import { skillSourceArtifactContentUrl } from "../../api.js";
import { formatDateTime } from "../../lib/formatting.js";
import { Button, InlineFeedback, InspectorSection, Skeleton } from "../../shared/ui/index.js";
import type {
  SkillOptimizationPreview,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export function SkillSourceInspector({
  skillId,
  snapshot,
  history,
  artifacts,
  sourceArtifactsLoading,
  sourceError,
  optimizationPreview,
  showPreviewAction = true,
  allowSourceMutations = true,
  cwd,
  busyAction,
  onPreviewOptimization,
  onArchive,
  onRollback,
  t,
}: {
  readonly skillId: string;
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly history: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly sourceArtifactsLoading: boolean;
  readonly sourceError: string;
  readonly optimizationPreview?: SkillOptimizationPreview;
  readonly showPreviewAction?: boolean;
  readonly allowSourceMutations?: boolean;
  readonly cwd: string;
  readonly busyAction: string;
  readonly onPreviewOptimization: () => void;
  readonly onArchive: () => void;
  readonly onRollback: (snapshotId: string) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const previewBusy = busyAction === `source-preview:${skillId}`;
  const archiveBusy = busyAction === `source-archive:${skillId}`;
  const hasBusyAction = Boolean(busyAction);

  if (!snapshot) {
    return (
      <div className="settings-skill-source-empty">
        {sourceError ? <InlineFeedback tone="danger">{sourceError}</InlineFeedback> : null}
        <p>{t("Metadata only. No published SKILL.md snapshot is attached yet.")}</p>
      </div>
    );
  }

  return (
    <div className="settings-skill-source-inspector">
      {sourceError ? <InlineFeedback tone="danger">{sourceError}</InlineFeedback> : null}
      <div className="settings-skill-source-detail">
        <span><small>{t("Snapshot")}</small><code>{snapshot.id}</code></span>
        <span><small>{t("Checksum")}</small><code>{snapshot.sourceChecksum}</code></span>
        <span><small>{t("Upstream")}</small><code>{[snapshot.upstreamName, snapshot.upstreamVersion].filter(Boolean).join(" ") || "-"}</code></span>
        <span><small>{t("Path")}</small><code>{snapshot.upstreamSkillPath ?? snapshot.sourcePath ?? "-"}</code></span>
      </div>
      <div className="settings-skill-source-tags">
        <span>{t("Files")}: {snapshot.referencedFiles.length}</span>
        <span>{t("Warnings")}: {snapshot.warnings.length}</span>
        <span>{t("Review")}: {snapshot.reviewStatus}</span>
        <span>{t("Artifacts")}: {artifacts.length}</span>
      </div>
      <div className="settings-skill-source-actions">
        {showPreviewAction ? (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Search size={14} />}
            loading={previewBusy}
            loadingLabel={t("Previewing...")}
            disabled={hasBusyAction && !previewBusy}
            onClick={onPreviewOptimization}
          >
            {t("Preview optimization")}
          </Button>
        ) : null}
        {allowSourceMutations ? (
          <Button
            size="sm"
            variant="danger"
            leadingIcon={<Archive size={14} />}
            loading={archiveBusy}
            loadingLabel={t("Loading...")}
            disabled={hasBusyAction && !archiveBusy}
            onClick={onArchive}
          >
            {t("Archive source snapshot")}
          </Button>
        ) : null}
      </div>

      {optimizationPreview ? (
        <div className="settings-skill-optimization-preview" aria-label={t("Skill optimization preview")}>
          <div className="settings-skill-source-detail">
            <span><small>{t("Mode")}</small><code>{optimizationPreview.mode}</code></span>
            <span><small>{t("Status")}</small><code>{optimizationPreview.status}</code></span>
            <span><small>{t("Original tokens")}</small><code>{optimizationPreview.originalTokenEstimate}</code></span>
            <span><small>{t("Compiled tokens")}</small><code>{optimizationPreview.compiledTokenEstimate}</code></span>
          </div>
          <div className="settings-skill-source-tags">
            <span>{t("Risks")}: {optimizationPreview.risks.length}</span>
            <span>{t("Lazy references")}: {optimizationPreview.compiledView?.lazyReferences.length ?? 0}</span>
            <span>{t("Authority unchanged")}</span>
          </div>
          {optimizationPreview.routingDescription?.suggested ? (
            <small>{t("Suggested routing")}: {optimizationPreview.routingDescription.suggested}</small>
          ) : null}
          {optimizationPreview.risks.length > 0 ? (
            <div className="settings-skill-source-warning-list">
              {optimizationPreview.risks.slice(0, 3).map((risk, index) => (
                <small key={`${risk.kind}:${index}`} className={risk.severity}>
                  {risk.title} · {risk.message}
                </small>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {snapshot.warnings.length > 0 ? (
        <div className="settings-skill-source-warning-list">
          {snapshot.warnings.slice(0, 4).map((warning, index) => (
            <small key={`${warning.code}:${warning.location ?? index}`} className={warning.severity}>
              {warning.severity}: {warning.code} · {warning.message}
            </small>
          ))}
        </div>
      ) : null}

      {sourceArtifactsLoading ? (
        <div className="settings-skill-source-artifacts-loading" role="status" aria-label={t("Loading...")}>
          <Skeleton shape="block" width="100%" height={42} />
        </div>
      ) : artifacts.length > 0 ? (
        <div className="settings-skill-source-warning-list">
          {artifacts.slice(0, 6).map((artifact) => (
            <small key={artifact.id} className={artifact.reviewStatus === "published" ? "info" : "warning"}>
              {artifact.kind}: <a href={skillSourceArtifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer">{artifact.path}</a> · {artifact.reviewStatus} · {artifact.sizeBytes} bytes
            </small>
          ))}
        </div>
      ) : null}

      {snapshot.rawSkillMarkdownArtifactId ? (
        <p>
          <a href={skillSourceArtifactContentUrl(snapshot.rawSkillMarkdownArtifactId, cwd)} target="_blank" rel="noreferrer">
            {t("Open full SKILL.md artifact")}
          </a>
        </p>
      ) : null}

      {allowSourceMutations && history.length > 0 ? (
        <div className="settings-skill-source-history">
          {history.slice(0, 4).map((archived) => {
            const rollbackBusy = busyAction === `source-rollback:${archived.id}`;
            return (
              <div key={archived.id} className="settings-skill-source-history-row">
                <span>{formatDateTime(archived.updatedAt)} · <code>{archived.sourceChecksum}</code></span>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<RotateCcw size={13} />}
                  loading={rollbackBusy}
                  loadingLabel={t("Loading...")}
                  disabled={hasBusyAction && !rollbackBusy}
                  onClick={() => onRollback(archived.id)}
                >
                  {t("Rollback")}
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}

      <InspectorSection className="settings-skill-source-preview" title={t("View SKILL.md")}>
        <pre>{snapshot.rawSkillMarkdown}</pre>
      </InspectorSection>
    </div>
  );
}
