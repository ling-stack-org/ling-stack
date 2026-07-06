import { useMemo } from "react";
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
