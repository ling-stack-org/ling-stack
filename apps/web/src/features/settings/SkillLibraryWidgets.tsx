import { type ReactNode } from "react";
import { AlertTriangle, Archive, BookOpen, CheckCircle2, Gauge, RefreshCw, Search } from "lucide-react";
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
  SkillSourceSemanticDiffItem,
  SkillSourceSnapshot,
  SkillSourceSyncDiffItem,
  SkillSourceSyncPreviewRecord,
  SkillSourceSyncPreviewReport,
  SkillSourceSyncRecordState,
  SkillSourceUpgradePolicy,
  TeammateSkillBinding,
} from "../../types.js";

import {
  SettingsTranslator,
  isSelectableSyncRecord,
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
  skillSourceSemanticDiffLabel,
  skillSourceSnapshotState,
  skillSourceSyncDiffLabel,
  skillSourceSyncStateLabel,
  sourceHealthKindLabel,
  sourceHealthMessage,
  sourceHealthTitle,
  syncRecordTitle,
} from "./skill-library-utils.js";
export {
  boundTeammateNames,
  defaultSelectedSyncSkillIds,
  isOpenSkillCandidateStatus,
  isSelectableSyncRecord,
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
  preview,
  policy,
  rootPath,
  includeDetectedRoots,
  allowNewSkills,
  selectedSkillIds,
  loading,
  syncing,
  onRootPathChange,
  onIncludeDetectedRootsChange,
  onAllowNewSkillsChange,
  onPreview,
  onRefresh,
  onCheckUpdates,
  onPolicyModeChange,
  onPublish,
  onToggleRecord,
  t,
}: {
  readonly preview: SkillSourceSyncPreviewReport | undefined;
  readonly policy: SkillSourceUpgradePolicy | undefined;
  readonly rootPath: string;
  readonly includeDetectedRoots: boolean;
  readonly allowNewSkills: boolean;
  readonly selectedSkillIds: readonly string[];
  readonly loading: boolean;
  readonly syncing: boolean;
  readonly onRootPathChange: (value: string) => void;
  readonly onIncludeDetectedRootsChange: (value: boolean) => void;
  readonly onAllowNewSkillsChange: (value: boolean) => void;
  readonly onPreview: () => void;
  readonly onRefresh: () => void;
  readonly onCheckUpdates: () => void;
  readonly onPolicyModeChange: (mode: SkillSourceUpgradePolicy["mode"]) => void;
  readonly onPublish: () => void;
  readonly onToggleRecord: (record: SkillSourceSyncPreviewRecord) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const records = preview?.records ?? [];
  const selectedSet = new Set(selectedSkillIds);
  const disabled = loading || syncing;
  return (
    <section className="settings-skill-source-sync" aria-label={t("gstack source sync")}>
      <header className="settings-skill-source-sync-head">
        <span>
          <RefreshCw size={15} className={syncing ? "spin" : undefined} />
          <strong>{t("gstack source sync")}</strong>
        </span>
        <small>
          {policy?.lastCheckedAt ? t("Checked {time}", { time: formatDateTime(policy.lastCheckedAt) }) : preview ? t("{count} records", { count: preview.summary.totalRecords }) : t("Preview before publishing")}
        </small>
      </header>
      <div className="settings-skill-source-sync-controls">
        <label className="field">
          <span>{t("Upgrade policy")}</span>
          <select
            value={policy?.mode ?? "prompt"}
            onChange={(event) => onPolicyModeChange(event.target.value as SkillSourceUpgradePolicy["mode"])}
            disabled={disabled || !policy}
          >
            <option value="manual">{t("Manual")}</option>
            <option value="prompt">{t("Prompt")}</option>
            <option value="auto-safe">{t("Auto-safe")}</option>
          </select>
        </label>
        <div className="settings-skill-source-sync-actions">
          <button className="secondary-button compact-button" type="button" onClick={onPreview} disabled={disabled || (!includeDetectedRoots && !rootPath.trim())}>
            <Search size={14} />
            {t("Preview")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={disabled || (!includeDetectedRoots && !rootPath.trim())}>
            <RefreshCw size={14} />
            {t("Refresh")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={onCheckUpdates} disabled={disabled || (!includeDetectedRoots && !rootPath.trim())}>
            <Gauge size={14} />
            {t("Check updates")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={onPublish} disabled={disabled || selectedSkillIds.length === 0}>
            <CheckCircle2 size={14} />
            {t("Publish selected")}
          </button>
        </div>
      </div>
      <details className="settings-compact-details settings-interaction-details settings-skill-source-config">
        <summary>{t("Sync settings")}</summary>
        <label className="field">
          <span>{t("Skill root paths")}</span>
          <textarea
            rows={2}
            value={rootPath}
            onChange={(event) => onRootPathChange(event.target.value)}
            placeholder="~/.gstack/repos/gstack/.agents/skills"
          />
        </label>
        <div className="settings-skill-source-sync-switches">
          <label className="settings-toggle">
            <input type="checkbox" checked={includeDetectedRoots} onChange={(event) => onIncludeDetectedRootsChange(event.target.checked)} />
            {t("Include detected roots")}
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={allowNewSkills} onChange={(event) => onAllowNewSkillsChange(event.target.checked)} />
            {t("Allow new skills")}
          </label>
        </div>
      </details>
      {preview ? (
        <div className="settings-skill-source-sync-summary" aria-label={t("gstack source sync summary")}>
          <span><small>{t("Attachable")}</small><strong>{preview.summary.attachable}</strong></span>
          <span><small>{t("Drifted")}</small><strong>{preview.summary.drifted}</strong></span>
          <span><small>{t("New")}</small><strong>{preview.summary.new}</strong></span>
          <span><small>{t("Blocked")}</small><strong>{preview.summary.blocked}</strong></span>
          <span><small>{t("Selected")}</small><strong>{selectedSkillIds.length}</strong></span>
        </div>
      ) : null}
      {records.length === 0 ? (
        <div className="compact-empty">{syncing ? t("Scanning source roots...") : t("No source preview loaded")}</div>
      ) : (
        <div className="settings-skill-source-sync-records">
          {records.map((record) => {
            const selectable = isSelectableSyncRecord(record, allowNewSkills);
            const selected = selectedSet.has(record.skillId);
            const title = syncRecordTitle(record);
            const path = record.upstreamSkillPath ?? record.sourcePath ?? "-";
            const diff = record.diff ?? [];
            const semanticDiff = record.semanticDiff ?? [];
            const contextFindings = record.contextFindings ?? [];
            const artifactReviewCount = record.referencedFiles.filter((file) => file.kind === "script" || file.kind === "asset").length;
            return (
              <article key={`${record.skillId}:${record.sourcePath ?? record.upstreamSkillPath ?? record.state}`} className={`settings-skill-source-sync-record ${record.state}`}>
                <label className="settings-skill-source-sync-select">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!selectable || disabled}
                    onChange={() => onToggleRecord(record)}
                    aria-label={t("Select {skill}", { skill: record.skillId })}
                  />
                </label>
                <div className="settings-skill-source-sync-main">
                  <div className="settings-skill-source-sync-title">
                    <span>
                      <strong>{title}</strong>
                      <small>{t("{files} files · {warnings} warnings", { files: record.referencedFiles.length, warnings: record.warnings.length })}</small>
                    </span>
                    <span className={`settings-skill-sync-state ${record.state}`}>{skillSourceSyncStateLabel(record.state, t)}</span>
                  </div>
                  <div className="settings-skill-source-sync-meta">
                    <span>{record.sourceKind ?? "-"}</span>
                    {record.sourceRootId ? <span>{t("Root")}: {record.sourceRootId}</span> : null}
                    <span>{t("Files")}: {record.referencedFiles.length}</span>
                    <span>{t("Warnings")}: {record.warnings.length}</span>
                    <span>{t("Context")}: {contextFindings.length}</span>
                    <span>{t("Semantic")}: {semanticDiff.length}</span>
                    {artifactReviewCount > 0 ? <span>{t("Artifact review")}: {artifactReviewCount}</span> : null}
                  </div>
                  {record.sourceChecksum || record.warnings.length > 0 || contextFindings.length > 0 || diff.length > 0 || semanticDiff.length > 0 ? (
                    <details className="settings-compact-details settings-skill-source-sync-details">
                      <summary>{t("Source evidence")}</summary>
                      <div className="settings-skill-source-sync-evidence-line">
                        <small>{t("Skill ID")}</small>
                        <code>{record.skillId}</code>
                      </div>
                      <div className="settings-skill-source-sync-evidence-line">
                        <small>{t("Source path")}</small>
                        <code>{path}</code>
                      </div>
                      {record.sourceChecksum ? (
                        <div className="settings-skill-source-sync-evidence-line">
                          <small>{t("Raw source checksum")}</small>
                          <code>{record.sourceChecksum}</code>
                        </div>
                      ) : null}
                      {record.warnings.length > 0 ? (
                        <div className="settings-skill-source-sync-warnings">
                          {record.warnings.slice(0, 2).map((warning, index) => (
                            <small key={`${warning.code}:${warning.location ?? index}`} className={warning.severity}>
                              {warning.severity}: {warning.code}
                            </small>
                          ))}
                        </div>
                      ) : null}
                      {contextFindings.length > 0 ? (
                        <div className="settings-skill-source-sync-context" aria-label={t("Context health for {skill}", { skill: record.skillId })}>
                          {contextFindings.slice(0, 3).map((finding, index) => (
                            <small key={`${finding.kind}:${index}`} className={finding.severity}>
                              {sourceHealthKindLabel(finding.kind, t)}: {sourceHealthTitle(finding, t)}
                            </small>
                          ))}
                        </div>
                      ) : null}
                      {diff.length > 0 ? (
                        <div className="settings-skill-source-sync-diff" aria-label={t("Drift diff for {skill}", { skill: record.skillId })}>
                          <span className="settings-skill-source-sync-diff-title">{t("Drift diff")} · {diff.length}</span>
                          <div className="settings-skill-source-sync-diff-items">
                            {diff.slice(0, 5).map((item) => (
                              <div key={item.field} className={`settings-skill-source-sync-diff-item ${item.severity}`}>
                                <small>{skillSourceSyncDiffLabel(item, t)}</small>
                                <code>{item.before ?? "-"}</code>
                                <span>→</span>
                                <code>{item.after ?? "-"}</code>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {semanticDiff.length > 0 ? (
                        <div className="settings-skill-source-sync-diff" aria-label={t("Semantic diff for {skill}", { skill: record.skillId })}>
                          <span className="settings-skill-source-sync-diff-title">{t("Semantic diff")} · {semanticDiff.length}</span>
                          <div className="settings-skill-source-sync-diff-items">
                            {semanticDiff.slice(0, 5).map((item, index) => (
                              <div key={`${item.kind}:${index}`} className={`settings-skill-source-sync-diff-item ${item.severity}`}>
                                <small>{skillSourceSemanticDiffLabel(item, t)}</small>
                                <code>{item.before ?? "-"}</code>
                                <span>→</span>
                                <code>{item.after ?? "-"}</code>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </details>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
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
  showState = true,
  t,
}: {
  readonly source: SkillPackSource;
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly showState?: boolean;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const sourceState = skillSourceSnapshotState(snapshot, t);
  return (
    <span className="settings-skill-source-status">
      <span>{skillSourceLabel(source, t)}</span>
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
        <button className="secondary-button danger compact-button" type="button" onClick={onArchive} disabled={saving}>
          <Archive size={14} />
          {t("Archive source snapshot")}
        </button>
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
      {history.length > 0 ? (
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
