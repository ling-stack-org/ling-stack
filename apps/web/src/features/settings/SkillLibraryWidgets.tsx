import { type ReactNode } from "react";
import { AlertTriangle, Archive, BookOpen, Gauge, RefreshCw, Search } from "lucide-react";
import type { OfficialSkillSourceState } from "@ling-stack/contracts";
import { skillSourceArtifactContentUrl } from "../../api.js";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  AiTeammate,
  SkillHealthFinding,
  SkillHealthReport,
  SkillHealthSeverity,
  SkillOptimizationPreview,
  SkillPackSource,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceHealthReport,
  SkillSourceSnapshot,
  TeammateSkillBinding,
} from "../../types.js";

import {
  SettingsTranslator,
  playbookCandidateReviewMessage,
  playbookCandidateReviewReason,
  skillCandidateReviewMessage,
  skillCandidateReviewReason,
  skillHealthActionLabel,
  skillHealthKindLabel,
  skillHealthSeverityLabel,
  skillLibraryFilterLabel,
  skillRegistryState,
  skillSourceLabel,
  skillSourceSnapshotState,
  sourceHealthKindLabel,
  sourceHealthMessage,
  sourceHealthTitle,
} from "./skill-library-utils.js";
import type { SkillSourceSyncResultView } from "./skill-source-sync-result-cache.js";

export {
  boundTeammateNames,
  isOpenSkillCandidateStatus,
  playbookCandidateReviewMessage,
  playbookCandidateReviewReason,
  skillCandidateReviewMessage,
  skillCandidateReviewReason,
  skillLibraryFilterLabel,
  skillRegistryState,
  sourceHealthKindLabel,
  type SkillLibraryFilter,
  type TeammateSkillBindingSummary,
} from "./skill-library-utils.js";

export function SkillSourceSyncPanel({
  source,
  result,
  loading,
  syncing,
  onSync,
  t,
}: {
  readonly source: OfficialSkillSourceState | undefined;
  readonly result: SkillSourceSyncResultView | undefined;
  readonly loading: boolean;
  readonly syncing: boolean;
  readonly onSync: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const disabled = loading || syncing;
  return (
    <section className="settings-skill-source-sync" aria-label={t("Official skill updates")}>
      <header className="settings-skill-source-sync-head">
        <span>
          <RefreshCw size={15} className={syncing ? "spin" : undefined} />
          <strong>{t("Official skill updates")}</strong>
          <small>
            {source?.lastSyncedAt
              ? t("Last sync {time}", { time: formatDateTime(source.lastSyncedAt) })
              : t("Ready to check official skills")}
          </small>
        </span>
        <button className="primary-button compact-button" type="button" onClick={onSync} disabled={disabled}>
          <RefreshCw size={14} className={syncing ? "spin" : undefined} />
          {t("Sync updates")}
        </button>
      </header>
      {source?.version ? (
        <div className="settings-skill-source-connection" role="status">
          <span>{t("Official version")}</span>
          <span>{source.version}</span>
        </div>
      ) : null}
      {result ? (
        <div className="settings-skill-source-sync-summary" aria-label={t("Skill sync summary")}>
          <span>{t("Synced")}: <strong>{result.summary.synced}</strong></span>
          <span>{t("Unchanged")}: <strong>{result.summary.unchanged}</strong></span>
        </div>
      ) : null}
    </section>
  );
}

export function SkillHealthPanel({
  report,
  loading,
  t,
}: {
  readonly report: SkillHealthReport | undefined;
  readonly loading: boolean;
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
}): JSX.Element {
  const findings = report?.findings ?? [];
  const summary = report?.summary;
  return (
    <section className="settings-skill-health" aria-label={t("Skill Health")}>
      <header className="settings-skill-health-head">
        <span>
          <Gauge size={15} />
          <strong>{t("Skill Health")}</strong>
        </span>
        <small>
          {report ? t("Generated {time}", { time: formatDateTime(report.generatedAt) }) : loading ? t("Loading skill health...") : t("No health report loaded")}
        </small>
      </header>
      <div className="settings-skill-health-summary" aria-label={t("Skill health summary")}>
        <span><small>{t("Critical")}</small><strong>{summary?.findings.critical ?? 0}</strong></span>
        <span><small>{t("Warnings")}</small><strong>{summary?.findings.warning ?? 0}</strong></span>
        <span><small>{t("Duplicate clusters")}</small><strong>{summary?.duplicateClusters ?? 0}</strong></span>
        <span><small>{t("Conflicts")}</small><strong>{summary?.conflictCount ?? 0}</strong></span>
      </div>
      {findings.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading skill health...") : t("No skill health findings")}</div>
      ) : (
        <div className="settings-skill-health-findings">
          {findings.map((finding) => (
            <SkillHealthFindingRow key={finding.id} finding={finding} t={t} />
          ))}
        </div>
      )}
    </section>
  );
}

function SkillHealthFindingRow({
  finding,
  t,
}: {
  readonly finding: SkillHealthFinding;
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
}): JSX.Element {
  const relatedIds = [...finding.skillIds, ...finding.candidateIds].slice(0, 4);
  return (
    <article className={`settings-skill-health-finding ${finding.severity}`}>
      <div className="settings-skill-health-finding-main">
        <span className="settings-skill-health-title">
          <AlertTriangle size={14} />
          <strong>{finding.title}</strong>
        </span>
        <p>{finding.message}</p>
        <small>{t("Recommended")}: {skillHealthActionLabel(finding.recommendedAction, t)}</small>
      </div>
      <div className="settings-skill-health-finding-meta">
        <SkillHealthSeverityPill severity={finding.severity} t={t} />
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Finding details")}</summary>
          <small>{skillHealthKindLabel(finding.kind, t)}</small>
          <SkillTokenList values={relatedIds} emptyLabel={t("No related ids")} />
        </details>
      </div>
    </article>
  );
}

export function SkillSourceHealthPanel({
  report,
  snapshots,
  loading,
  t,
}: {
  readonly report: SkillSourceHealthReport | undefined;
  readonly snapshots: readonly SkillSourceSnapshot[];
  readonly loading: boolean;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const findings = report?.findings ?? [];
  const summary = report?.summary;
  return (
    <section className="settings-skill-health settings-skill-source-health" aria-label={t("Skill Source Health")}>
      <header className="settings-skill-health-head">
        <span>
          <BookOpen size={15} />
          <strong>{t("Skill Source Health")}</strong>
        </span>
        <small>
          {report ? t("Generated {time}", { time: formatDateTime(report.generatedAt) }) : loading ? t("Loading skill source health...") : t("No source health report loaded")}
        </small>
      </header>
      <div className="settings-skill-health-summary" aria-label={t("Skill source summary")}>
        <span><small>{t("Source-backed")}</small><strong>{summary?.sourceBackedSkills ?? snapshots.length}</strong></span>
        <span><small>{t("Missing source")}</small><strong>{summary?.missingSourceSnapshots ?? 0}</strong></span>
        <span><small>{t("Warning snapshots")}</small><strong>{summary?.warningSnapshots ?? 0}</strong></span>
        <span><small>{t("Orphaned")}</small><strong>{summary?.orphanedSnapshots ?? 0}</strong></span>
      </div>
      {findings.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading skill source health...") : t("No skill source findings")}</div>
      ) : (
        <div className="settings-skill-health-findings">
          {findings.map((finding) => (
            <article key={`${finding.kind}:${finding.skillId ?? finding.snapshotId ?? finding.title}`} className={`settings-skill-health-finding ${finding.severity}`}>
              <div className="settings-skill-health-finding-main">
                <span className="settings-skill-health-title">
                  <AlertTriangle size={14} />
                  <strong>{sourceHealthTitle(finding, t)}</strong>
                </span>
                <p>{sourceHealthMessage(finding, t)}</p>
                <small>{sourceHealthKindLabel(finding.kind, t)}</small>
                {finding.recommendation || finding.evidence?.length ? (
                  <details className="settings-compact-details settings-interaction-details">
                    <summary>{t("Source finding details")}</summary>
                    {finding.recommendation ? <small>{t("Recommendation")}: {finding.recommendation}</small> : null}
                    {finding.evidence?.length ? (
                      <small>
                        {t("Evidence")}: {finding.evidence.slice(0, 3).map((item) => item.sourceRef).join(", ")}
                      </small>
                    ) : null}
                  </details>
                ) : null}
              </div>
              <div className="settings-skill-health-finding-meta">
                <SkillHealthSeverityPill severity={finding.severity} t={t} />
                <SkillTokenList values={[finding.skillId, finding.snapshotId].filter((value): value is string => Boolean(value))} emptyLabel={t("No related ids")} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function SkillSourceStatus({
  source,
  snapshot,
  showSource = true,
  showState = true,
  t,
}: {
  readonly source: SkillPackSource;
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly showSource?: boolean;
  readonly showState?: boolean;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const sourceState = skillSourceSnapshotState(snapshot, t);
  return (
    <span className="settings-skill-source-status">
      {showSource ? <span>{skillSourceLabel(source, t)}</span> : null}
      {showState ? <small className={sourceState.tone}>{sourceState.label}</small> : null}
    </span>
  );
}

export function SkillSourceInspector({
  snapshot,
  history,
  artifacts,
  optimizationPreview,
  optimizationPreviewLoading,
  showPreviewAction = true,
  allowSourceMutations = true,
  cwd,
  saving,
  onPreviewOptimization,
  onArchive,
  onRollback,
  t,
}: {
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly history: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly optimizationPreview?: SkillOptimizationPreview;
  readonly optimizationPreviewLoading: boolean;
  readonly showPreviewAction?: boolean;
  readonly allowSourceMutations?: boolean;
  readonly cwd: string;
  readonly saving: boolean;
  readonly onPreviewOptimization: () => void;
  readonly onArchive: () => void;
  readonly onRollback: (snapshotId: string) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  if (!snapshot) {
    return (
      <SkillInspectorSection title={t("Source snapshot")}>
        <p>{t("Metadata only. No published SKILL.md snapshot is attached yet.")}</p>
      </SkillInspectorSection>
    );
  }

  return (
    <SkillInspectorSection title={t("Source snapshot")}>
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
          <button className="secondary-button compact-button" type="button" onClick={onPreviewOptimization} disabled={saving || optimizationPreviewLoading}>
            <Search size={14} />
            {optimizationPreviewLoading ? t("Previewing...") : t("Preview optimization")}
          </button>
        ) : null}
        {allowSourceMutations ? (
          <button className="secondary-button danger compact-button" type="button" onClick={onArchive} disabled={saving}>
            <Archive size={14} />
            {t("Archive source snapshot")}
          </button>
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
      {artifacts.length > 0 ? (
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
        <div className="settings-skill-source-warning-list">
          {history.slice(0, 4).map((archived) => (
            <small key={archived.id} className="info">
              {formatDateTime(archived.updatedAt)} · {archived.sourceChecksum}
              <button className="ghost-button compact-button" type="button" onClick={() => onRollback(archived.id)} disabled={saving}>
                {t("Rollback")}
              </button>
            </small>
          ))}
        </div>
      ) : null}
      <details className="settings-skill-source-preview">
        <summary>{t("View SKILL.md")}</summary>
        <pre>{snapshot.rawSkillMarkdown}</pre>
      </details>
    </SkillInspectorSection>
  );
}

function SkillHealthSeverityPill({
  severity,
  t,
}: {
  readonly severity: SkillHealthSeverity;
  readonly t: (key: string) => string;
}): JSX.Element {
  return <span className={`settings-skill-health-severity ${severity}`}>{skillHealthSeverityLabel(severity, t)}</span>;
}

export function SkillTokenList({ values, emptyLabel }: { readonly values: readonly string[]; readonly emptyLabel: string }): JSX.Element {
  if (values.length === 0) {
    return <span className="settings-skill-empty-token">{emptyLabel}</span>;
  }
  return (
    <span className="settings-skill-token-list">
      {values.slice(0, 4).map((value) => <code key={value}>{value}</code>)}
      {values.length > 4 ? <small>+{values.length - 4}</small> : null}
    </span>
  );
}

export function SkillInspectorSection({ title, children }: { readonly title: string; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="settings-skill-inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function SkillStatePill({ label, tone }: { readonly label: string; readonly tone: "bindable" | "draft" | "blocked" | "archived" }): JSX.Element {
  return <span className={`settings-skill-state ${tone}`}>{label}</span>;
}
