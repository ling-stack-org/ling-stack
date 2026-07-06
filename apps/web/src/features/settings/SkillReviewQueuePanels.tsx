import { useMemo, useState } from "react";
import { Archive, BookOpen, CheckCircle2, Upload } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  Channel,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
} from "../../types.js";
import { SkillTokenList } from "./SkillLibraryWidgets.js";
import {
  type SettingsTranslator,
  candidateRouteBlockerLabel,
  candidateRouteKindLabel,
  isOpenSkillCandidateStatus,
  isTerminalSkillCandidateStatus,
  playbookCandidateStatusLabel,
  procedureObservationClusterActionLabel,
  procedureObservationClusterStatusLabel,
  skillCandidateGate,
  skillCandidateOriginLabel,
  skillCandidateStatusLabel,
  skillDuplicateDecisionLabel,
} from "./skill-library-utils.js";

type SkillReviewQueueFilter = "all" | "skill_candidates" | "clusters" | "playbooks";

interface SkillReviewQueueItem {
  readonly id: string;
  readonly kind: Exclude<SkillReviewQueueFilter, "all">;
  readonly updatedAt: string;
}

interface SkillCandidateQueueItem extends SkillReviewQueueItem {
  readonly kind: "skill_candidates";
  readonly candidate: SkillCandidate;
}

interface ProcedureClusterQueueItem extends SkillReviewQueueItem {
  readonly kind: "clusters";
  readonly cluster: ProcedureObservationCluster;
}

interface PlaybookCandidateQueueItem extends SkillReviewQueueItem {
  readonly kind: "playbooks";
  readonly candidate: ChannelPlaybookCandidate;
}

type SkillReviewQueueListItem = SkillCandidateQueueItem | ProcedureClusterQueueItem | PlaybookCandidateQueueItem;

export function SkillReviewQueuePanel({
  skillCandidates,
  clusters,
  playbookCandidates,
  channels,
  loading,
  saving,
  onReviewSkillCandidate,
  onCreateDraft,
  onCreateProtocolCandidate,
  onCreatePlaybookCandidate,
  onReviewPlaybookCandidate,
  t,
}: {
  readonly skillCandidates: readonly SkillCandidate[];
  readonly clusters: readonly ProcedureObservationCluster[];
  readonly playbookCandidates: readonly ChannelPlaybookCandidate[];
  readonly channels: readonly Channel[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onReviewSkillCandidate: (candidateId: string, action: SkillCandidateReviewAction) => void;
  readonly onCreateDraft: (candidateId: string) => void;
  readonly onCreateProtocolCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onCreatePlaybookCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onReviewPlaybookCandidate: (candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const [activeFilter, setActiveFilter] = useState<SkillReviewQueueFilter>("all");
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name])), [channels]);
  const openSkillCandidates = useMemo(() => skillCandidates.filter((candidate) => isOpenSkillCandidateStatus(candidate.status)), [skillCandidates]);
  const sortedClusters = useMemo(() => [...clusters].sort((left, right) => {
    const statusRank: Record<ProcedureObservationCluster["status"], number> = {
      ready_for_review: 0,
      blocked: 1,
      collecting: 2,
      routed_elsewhere: 3,
    };
    const rank = statusRank[left.status] - statusRank[right.status];
    return rank !== 0 ? rank : right.lastObservedAt.localeCompare(left.lastObservedAt);
  }), [clusters]);
  const sortedPlaybookCandidates = useMemo(() => sortPlaybookCandidates(playbookCandidates), [playbookCandidates]);
  const queueItems = useMemo<readonly SkillReviewQueueListItem[]>(() => [
    ...openSkillCandidates.map((candidate): SkillCandidateQueueItem => ({
      id: `skill:${candidate.id}`,
      kind: "skill_candidates",
      updatedAt: candidate.updatedAt,
      candidate,
    })),
    ...sortedClusters.map((cluster): ProcedureClusterQueueItem => ({
      id: `cluster:${cluster.id}`,
      kind: "clusters",
      updatedAt: cluster.lastObservedAt,
      cluster,
    })),
    ...sortedPlaybookCandidates.map((candidate): PlaybookCandidateQueueItem => ({
      id: `playbook:${candidate.id}`,
      kind: "playbooks",
      updatedAt: candidate.updatedAt,
      candidate,
    })),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [openSkillCandidates, sortedClusters, sortedPlaybookCandidates]);
  const counts: Record<SkillReviewQueueFilter, number> = {
    all: queueItems.length,
    skill_candidates: openSkillCandidates.length,
    clusters: sortedClusters.length,
    playbooks: sortedPlaybookCandidates.length,
  };
  const visibleItems = activeFilter === "all"
    ? queueItems
    : queueItems.filter((item) => item.kind === activeFilter);
  const filters: readonly { readonly id: SkillReviewQueueFilter; readonly label: string }[] = [
    { id: "all", label: t("All") },
    { id: "skill_candidates", label: t("Skill candidates") },
    { id: "clusters", label: t("Candidate Clusters") },
    { id: "playbooks", label: t("Playbooks") },
  ];

  return (
    <section className="settings-skill-review-queue" aria-label={t("Skill review queue")}>
      <header className="settings-skill-candidate-head settings-skill-review-queue-head">
        <span>
          <CheckCircle2 size={15} />
          <strong>{t("Review queue")}</strong>
        </span>
        <small>{t("{count} skill review items", { count: queueItems.length })}</small>
      </header>
      <div className="settings-skill-review-filters" role="tablist" aria-label={t("Review queue filters")}>
        {filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            role="tab"
            aria-selected={activeFilter === filter.id}
            className={activeFilter === filter.id ? "active" : ""}
            onClick={() => setActiveFilter(filter.id)}
          >
            <span>{filter.label}</span>
            <small>{counts[filter.id]}</small>
          </button>
        ))}
      </div>
      {visibleItems.length === 0 ? (
        <div className="compact-empty settings-skill-review-empty">
          {loading ? t("Loading review queue...") : activeFilter === "all" ? t("No review items need attention") : t("No review items in this filter")}
        </div>
      ) : (
        <div className="settings-skill-candidate-list settings-skill-review-queue-list">
          {visibleItems.map((item) => {
            switch (item.kind) {
              case "skill_candidates":
                return (
                  <SkillCandidateReviewCard
                    key={item.id}
                    candidate={item.candidate}
                    saving={saving}
                    onReview={onReviewSkillCandidate}
                    onCreateDraft={onCreateDraft}
                    t={t}
                  />
                );
              case "clusters":
                return (
                  <ProcedureObservationClusterCard
                    key={item.id}
                    cluster={item.cluster}
                    saving={saving}
                    onCreateProtocolCandidate={onCreateProtocolCandidate}
                    onCreatePlaybookCandidate={onCreatePlaybookCandidate}
                    t={t}
                  />
                );
              case "playbooks":
                return (
                  <PlaybookCandidateCard
                    key={item.id}
                    candidate={item.candidate}
                    channelName={channelNames.get(item.candidate.channelId) ?? item.candidate.channelId}
                    saving={saving}
                    onReview={onReviewPlaybookCandidate}
                    t={t}
                  />
                );
            }
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

function ProcedureObservationClusterCard({
  cluster,
  saving,
  onCreateProtocolCandidate,
  onCreatePlaybookCandidate,
  t,
}: {
  readonly cluster: ProcedureObservationCluster;
  readonly saving: boolean;
  readonly onCreateProtocolCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onCreatePlaybookCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
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
    <article className="settings-skill-candidate-card settings-skill-review-queue-card" data-review-kind="clusters">
      <div className="settings-skill-candidate-main">
        <div className="settings-skill-candidate-title">
          <span>
            <small>{t("Candidate Clusters")}</small>
            <strong>{cluster.title}</strong>
            <small>{candidateRouteKindLabel(cluster.routeKind, t)}</small>
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
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Cluster details")}</summary>
          <div className="settings-skill-candidate-gates">
            <span>
              <small>{t("Cluster ID")}</small>
              <code>{cluster.id}</code>
            </span>
            <span>
              <small>{t("Triggers")}</small>
              <SkillTokenList values={cluster.positiveTriggers} emptyLabel={t("No positive triggers")} />
            </span>
            <span>
              <small>{t("Blockers")}</small>
              <SkillTokenList values={cluster.routeBlockers.map((blocker) => candidateRouteBlockerLabel(blocker, t))} emptyLabel={t("No blockers")} />
            </span>
          </div>
        </details>
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
}

function PlaybookCandidateCard({
  candidate,
  channelName,
  saving,
  onReview,
  t,
}: {
  readonly candidate: ChannelPlaybookCandidate;
  readonly channelName: string;
  readonly saving: boolean;
  readonly onReview: (candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const canReview = candidate.status === "draft";
  return (
    <article className="settings-skill-candidate-card settings-skill-review-queue-card" data-review-kind="playbooks">
      <div className="settings-skill-candidate-main">
        <div className="settings-skill-candidate-title">
          <span>
            <small>{t("Playbooks")}</small>
            <strong>{candidate.title}</strong>
            <small>{channelName}</small>
          </span>
          <span className={`settings-skill-candidate-status ${candidate.status}`}>{playbookCandidateStatusLabel(candidate.status, t)}</span>
        </div>
        <p>{candidate.summary}</p>
        <div className="settings-skill-candidate-meta">
          <span>{t("Goal")}: {candidate.normalizedGoal}</span>
          <span>{t("Reason")}: {candidate.reason}</span>
          <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
        </div>
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Playbook details")}</summary>
          <div className="settings-skill-candidate-gates">
            <span>
              <small>{t("Candidate ID")}</small>
              <code>{candidate.id}</code>
            </span>
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
        </details>
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
}

function SkillCandidateReviewCard({
  candidate,
  saving,
  onReview,
  onCreateDraft,
  t,
}: {
  readonly candidate: SkillCandidate;
  readonly saving: boolean;
  readonly onReview: (candidateId: string, action: SkillCandidateReviewAction) => void;
  readonly onCreateDraft: (candidateId: string) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const gate = skillCandidateGate(candidate, t);
  const canApprove = (candidate.status === "pending" || candidate.status === "needs_edit") && !gate.approvalBlocked;
  const canReject = !isTerminalSkillCandidateStatus(candidate.status);
  const canCreateDraft = candidate.status === "approved_for_draft" && !gate.draftBlocked;
  return (
    <article className="settings-skill-candidate-card settings-skill-review-queue-card" data-review-kind="skill_candidates">
      <div className="settings-skill-candidate-main">
        <div className="settings-skill-candidate-title">
          <span>
            <small>{t("Skill candidates")}</small>
            <strong>{candidate.title}</strong>
            <small>{skillCandidateOriginLabel(candidate.origin, t)}</small>
          </span>
          <SkillCandidateStatusPill candidate={candidate} t={t} />
        </div>
        <p>{candidate.summary}</p>
        <div className="settings-skill-candidate-meta">
          <span>{t("Duplicate")}: {skillDuplicateDecisionLabel(candidate.duplicateAnalysis.decision, t)}</span>
          <span>{t("Similarity")}: {Math.round(candidate.duplicateAnalysis.similarityScore * 100)}%</span>
          <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
        </div>
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Candidate details")}</summary>
          <div className="settings-skill-candidate-gates">
            <span>
              <small>{t("Candidate ID")}</small>
              <code>{candidate.id}</code>
            </span>
            <span>
              <small>{t("Gates")}</small>
              <SkillTokenList values={gate.labels} emptyLabel={t("Draft gates clear")} />
            </span>
            <span>
              <small>{t("Source refs")}</small>
              <SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} />
            </span>
          </div>
        </details>
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
}

function sortPlaybookCandidates(candidates: readonly ChannelPlaybookCandidate[]): readonly ChannelPlaybookCandidate[] {
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
}
