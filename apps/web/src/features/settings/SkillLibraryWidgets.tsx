import { useMemo, type ReactNode } from "react";
import { AlertTriangle, Archive, BookOpen, CheckCircle2, Gauge, RefreshCw, Search, Upload } from "lucide-react";
import { skillSourceArtifactContentUrl } from "../../api.js";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  AiTeammate,
  Channel,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
  SkillHealthFinding,
  SkillHealthReport,
  SkillHealthSeverity,
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
  candidateRouteBlockerLabel,
  candidateRouteKindLabel,
  isOpenSkillCandidateStatus,
  isSelectableSyncRecord,
  isTerminalSkillCandidateStatus,
  playbookCandidateReviewMessage,
  playbookCandidateReviewReason,
  playbookCandidateStatusLabel,
  procedureObservationClusterActionLabel,
  procedureObservationClusterStatusLabel,
  skillCandidateGate,
  skillCandidateOriginLabel,
  skillCandidateReviewMessage,
  skillCandidateReviewReason,
  skillCandidateStatusLabel,
  skillDuplicateDecisionLabel,
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
                      <small>{record.skillId} · {path}</small>
                    </span>
                    <span className={`settings-skill-sync-state ${record.state}`}>{skillSourceSyncStateLabel(record.state, t)}</span>
                  </div>
                  <div className="settings-skill-source-sync-meta">
                    <span>{record.sourceKind ?? "-"}</span>
                    {record.sourceRootId ? <span>{t("Root")}: {record.sourceRootId}</span> : null}
                    <span>{t("Files")}: {record.referencedFiles.length}</span>
                    <span>{t("Warnings")}: {record.warnings.length}</span>
                    <span>{t("Semantic")}: {semanticDiff.length}</span>
                    {artifactReviewCount > 0 ? <span>{t("Artifact review")}: {artifactReviewCount}</span> : null}
                    {record.sourceChecksum ? <span>{record.sourceChecksum}</span> : null}
                  </div>
                  {record.warnings.length > 0 ? (
                    <div className="settings-skill-source-sync-warnings">
                      {record.warnings.slice(0, 2).map((warning, index) => (
                        <small key={`${warning.code}:${warning.location ?? index}`} className={warning.severity}>
                          {warning.severity}: {warning.code}
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
        <small>{skillHealthKindLabel(finding.kind, t)} · {t("Action")}: {skillHealthActionLabel(finding.recommendedAction, t)}</small>
      </div>
      <div className="settings-skill-health-finding-meta">
        <SkillHealthSeverityPill severity={finding.severity} t={t} />
        <SkillTokenList values={relatedIds} emptyLabel={t("No related ids")} />
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
  const visibleFindings = findings.slice(0, 6);
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
          {visibleFindings.map((finding) => (
            <article key={`${finding.kind}:${finding.skillId ?? finding.snapshotId ?? finding.title}`} className={`settings-skill-health-finding ${finding.severity}`}>
              <div className="settings-skill-health-finding-main">
                <span className="settings-skill-health-title">
                  <AlertTriangle size={14} />
                  <strong>{sourceHealthTitle(finding, t)}</strong>
                </span>
                <p>{sourceHealthMessage(finding, t)}</p>
                <small>{sourceHealthKindLabel(finding.kind, t)}</small>
              </div>
              <div className="settings-skill-health-finding-meta">
                <SkillHealthSeverityPill severity={finding.severity} t={t} />
                <SkillTokenList values={[finding.skillId, finding.snapshotId].filter((value): value is string => Boolean(value))} emptyLabel={t("No related ids")} />
              </div>
            </article>
          ))}
          {findings.length > visibleFindings.length ? (
            <div className="compact-empty">{t("{count} more source findings hidden by default", { count: findings.length - visibleFindings.length })}</div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function SkillSourceStatus({
  source,
  snapshot,
  t,
}: {
  readonly source: SkillPackSource;
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const sourceState = skillSourceSnapshotState(snapshot, t);
  return (
    <span className="settings-skill-source-status">
      <span>{skillSourceLabel(source, t)}</span>
      <small className={sourceState.tone}>{sourceState.label}</small>
    </span>
  );
}

export function SkillSourceInspector({
  snapshot,
  history,
  artifacts,
  cwd,
  saving,
  onArchive,
  onRollback,
  t,
}: {
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly history: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly cwd: string;
  readonly saving: boolean;
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
        <button className="secondary-button danger compact-button" type="button" onClick={onArchive} disabled={saving}>
          <Archive size={14} />
          {t("Archive source snapshot")}
        </button>
      </div>
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

export function ProcedureObservationClusterPanel({
  clusters,
  loading,
  saving,
  onCreateProtocolCandidate,
  onCreatePlaybookCandidate,
  t,
}: {
  readonly clusters: readonly ProcedureObservationCluster[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onCreateProtocolCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onCreatePlaybookCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const reviewable = clusters.filter((cluster) => cluster.status === "ready_for_review");
  const blocked = clusters.filter((cluster) => cluster.status === "blocked");
  return (
    <section className="settings-skill-candidate-review settings-skill-clusters" aria-label={t("Candidate Clusters")}>
      <header className="settings-skill-candidate-head">
        <span>
          <CheckCircle2 size={15} />
          <strong>{t("Candidate Clusters")}</strong>
        </span>
        <small>{t("{review} review · {blocked} blocked · {total} total", { review: reviewable.length, blocked: blocked.length, total: clusters.length })}</small>
      </header>
      {clusters.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading candidate clusters...") : t("No candidate clusters yet")}</div>
      ) : (
        <div className="settings-skill-candidate-list">
          {clusters.slice(0, 6).map((cluster) => {
            const canCreateProtocolCandidate = cluster.channelId &&
              cluster.routeKind === "channel_protocol" &&
              cluster.status === "ready_for_review" &&
              cluster.recommendedAction === "create_channel_protocol_candidate" &&
              cluster.routeBlockers.length === 0;
            const canCreatePlaybookCandidate = cluster.channelId &&
              cluster.routeKind === "playbook" &&
              cluster.status === "ready_for_review" &&
              cluster.recommendedAction === "create_playbook_candidate" &&
              cluster.routeBlockers.length === 0;
            return (
              <article key={cluster.id} className="settings-skill-candidate-card">
                <div className="settings-skill-candidate-main">
                  <div className="settings-skill-candidate-title">
                    <span>
                      <strong>{cluster.title}</strong>
                      <small>{cluster.id} · {candidateRouteKindLabel(cluster.routeKind, t)}</small>
                    </span>
                    <span className={`settings-skill-candidate-status ${cluster.status}`}>{procedureObservationClusterStatusLabel(cluster.status, t)}</span>
                  </div>
                  <p>{cluster.summary}</p>
                  <div className="settings-skill-candidate-meta">
                    <span>{t("Recommended")}: {procedureObservationClusterActionLabel(cluster.recommendedAction, t)}</span>
                    <span>{t("Evidence")}: {cluster.observationCount}</span>
                    <span>{t("Reusable")}: {cluster.reusableScore}</span>
                    <span>{t("Updated {time}", { time: formatDateTime(cluster.lastObservedAt) })}</span>
                  </div>
                  <div className="settings-skill-candidate-gates">
                    <span>
                      <small>{t("Triggers")}</small>
                      <SkillTokenList values={cluster.positiveTriggers} emptyLabel={t("No positive triggers")} />
                    </span>
                    <span>
                      <small>{t("Blockers")}</small>
                      <SkillTokenList values={cluster.routeBlockers.map((blocker) => candidateRouteBlockerLabel(blocker, t))} emptyLabel={t("No blockers")} />
                    </span>
                  </div>
                </div>
                {canCreateProtocolCandidate ? (
                  <div className="settings-skill-candidate-actions">
                    <button className="primary-button compact-button" type="button" onClick={() => onCreateProtocolCandidate(cluster)} disabled={saving}>
                      <BookOpen size={14} />
                      {t("Create protocol candidate")}
                    </button>
                  </div>
                ) : null}
                {canCreatePlaybookCandidate ? (
                  <div className="settings-skill-candidate-actions">
                    <button className="primary-button compact-button" type="button" onClick={() => onCreatePlaybookCandidate(cluster)} disabled={saving}>
                      <BookOpen size={14} />
                      {t("Create playbook candidate")}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function PlaybookCandidateReviewPanel({
  candidates,
  channels,
  loading,
  saving,
  onReview,
  t,
}: {
  readonly candidates: readonly ChannelPlaybookCandidate[];
  readonly channels: readonly Channel[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onReview: (candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name])), [channels]);
  const draftCount = candidates.filter((candidate) => candidate.status === "draft").length;
  const activeCount = candidates.filter((candidate) => candidate.status === "active").length;
  const rows = useMemo(() => {
    const statusRank: Record<ChannelPlaybookCandidate["status"], number> = {
      draft: 0,
      active: 1,
      stale: 2,
      cancelled: 3,
    };
    return [...candidates].sort((left, right) => {
      const rank = statusRank[left.status] - statusRank[right.status];
      return rank !== 0 ? rank : right.updatedAt.localeCompare(left.updatedAt);
    });
  }, [candidates]);

  return (
    <section className="settings-skill-candidate-review settings-playbook-candidate-review" aria-label={t("Playbook Candidate Review")}>
      <header className="settings-skill-candidate-head">
        <span>
          <BookOpen size={15} />
          <strong>{t("Playbook Candidate Review")}</strong>
        </span>
        <small>{t("{draft} draft · {active} active · {total} total", { draft: draftCount, active: activeCount, total: candidates.length })}</small>
      </header>
      {rows.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading playbook candidates...") : t("No playbook candidates")}</div>
      ) : (
        <div className="settings-skill-candidate-list">
          {rows.slice(0, 8).map((candidate) => {
            const canReview = candidate.status === "draft";
            const channelName = channelNames.get(candidate.channelId) ?? candidate.channelId;
            return (
              <article key={candidate.id} className="settings-skill-candidate-card">
                <div className="settings-skill-candidate-main">
                  <div className="settings-skill-candidate-title">
                    <span>
                      <strong>{candidate.title}</strong>
                      <small>{channelName} · {candidate.id}</small>
                    </span>
                    <span className={`settings-skill-candidate-status ${candidate.status}`}>{playbookCandidateStatusLabel(candidate.status, t)}</span>
                  </div>
                  <p>{candidate.summary}</p>
                  <div className="settings-skill-candidate-meta">
                    <span>{t("Goal")}: {candidate.normalizedGoal}</span>
                    <span>{t("Reason")}: {candidate.reason}</span>
                    <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
                  </div>
                  <div className="settings-skill-candidate-gates">
                    <span>
                      <small>{t("Steps")}</small>
                      <SkillTokenList values={candidate.procedureSteps.map((step) => step.title)} emptyLabel={t("No procedure steps")} />
                    </span>
                    <span>
                      <small>{t("Validation")}</small>
                      <SkillTokenList values={candidate.validationSteps.map((step) => step.title)} emptyLabel={t("No validation steps")} />
                    </span>
                    <span>
                      <small>{t("Triggers")}</small>
                      <SkillTokenList values={candidate.positiveTriggers} emptyLabel={t("No positive triggers")} />
                    </span>
                    <span>
                      <small>{t("Avoid triggers")}</small>
                      <SkillTokenList values={candidate.negativeTriggers} emptyLabel={t("No avoid triggers")} />
                    </span>
                    <span>
                      <small>{t("Source refs")}</small>
                      <SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} />
                    </span>
                  </div>
                </div>
                <div className="settings-skill-candidate-actions">
                  <button className="primary-button compact-button" type="button" onClick={() => onReview(candidate, "approve")} disabled={saving || !canReview}>
                    <CheckCircle2 size={14} />
                    {t("Approve playbook")}
                  </button>
                  <button className="secondary-button danger compact-button" type="button" onClick={() => onReview(candidate, "reject")} disabled={saving || !canReview}>
                    <Archive size={14} />
                    {t("Reject playbook")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function SkillCandidateReviewPanel({
  candidates,
  loading,
  saving,
  onReview,
  onCreateDraft,
  t,
}: {
  readonly candidates: readonly SkillCandidate[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onReview: (candidateId: string, action: SkillCandidateReviewAction) => void;
  readonly onCreateDraft: (candidateId: string) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const openCandidates = candidates.filter((candidate) => isOpenSkillCandidateStatus(candidate.status));
  return (
    <section className="settings-skill-candidate-review" aria-label={t("Skill Candidate Review")}>
      <header className="settings-skill-candidate-head">
        <span>
          <CheckCircle2 size={15} />
          <strong>{t("Skill Candidate Review")}</strong>
        </span>
        <small>{t("{open} open · {total} total", { open: openCandidates.length, total: candidates.length })}</small>
      </header>
      {openCandidates.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading skill candidates...") : t("No open skill candidates")}</div>
      ) : (
        <div className="settings-skill-candidate-list">
          {openCandidates.map((candidate) => {
            const gate = skillCandidateGate(candidate, t);
            const canApprove = (candidate.status === "pending" || candidate.status === "needs_edit") && !gate.approvalBlocked;
            const canReject = !isTerminalSkillCandidateStatus(candidate.status);
            const canCreateDraft = candidate.status === "approved_for_draft" && !gate.draftBlocked;
            return (
              <article key={candidate.id} className="settings-skill-candidate-card">
                <div className="settings-skill-candidate-main">
                  <div className="settings-skill-candidate-title">
                    <span>
                      <strong>{candidate.title}</strong>
                      <small>{candidate.id} · {skillCandidateOriginLabel(candidate.origin, t)}</small>
                    </span>
                    <SkillCandidateStatusPill candidate={candidate} t={t} />
                  </div>
                  <p>{candidate.summary}</p>
                  <div className="settings-skill-candidate-meta">
                    <span>{t("Duplicate")}: {skillDuplicateDecisionLabel(candidate.duplicateAnalysis.decision, t)}</span>
                    <span>{t("Similarity")}: {Math.round(candidate.duplicateAnalysis.similarityScore * 100)}%</span>
                    <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
                  </div>
                  <div className="settings-skill-candidate-gates">
                    <span>
                      <small>{t("Gates")}</small>
                      <SkillTokenList values={gate.labels} emptyLabel={t("Draft gates clear")} />
                    </span>
                    <span>
                      <small>{t("Source refs")}</small>
                      <SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} />
                    </span>
                  </div>
                </div>
                <div className="settings-skill-candidate-actions">
                  {candidate.status === "approved_for_draft" ? (
                    <button className="primary-button compact-button" type="button" onClick={() => onCreateDraft(candidate.id)} disabled={saving || !canCreateDraft}>
                      <Upload size={14} />
                      {t("Create registry draft")}
                    </button>
                  ) : (
                    <button className="secondary-button compact-button" type="button" onClick={() => onReview(candidate.id, "approve_for_draft")} disabled={saving || !canApprove}>
                      <CheckCircle2 size={14} />
                      {t("Approve for draft")}
                    </button>
                  )}
                  {canReject ? (
                    <button className="secondary-button danger compact-button" type="button" onClick={() => onReview(candidate.id, "reject")} disabled={saving}>
                      <Archive size={14} />
                      {t("Reject candidate")}
                    </button>
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

function SkillCandidateStatusPill({
  candidate,
  t,
}: {
  readonly candidate: SkillCandidate;
  readonly t: SettingsTranslator;
}): JSX.Element {
  return <span className={`settings-skill-candidate-status ${candidate.status}`}>{skillCandidateStatusLabel(candidate.status, t)}</span>;
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
