import { Archive, BookOpen, CheckCircle2 } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import { Button, InspectorSection, StatusIndicator, type StatusTone } from "../../shared/ui/index.js";
import type {
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
} from "../../types.js";
import { SkillTokenList } from "./SkillLibraryPrimitives.js";
import {
  type SettingsTranslator,
  candidateRouteBlockerLabel,
  candidateRouteKindLabel,
  isTerminalSkillCandidateStatus,
  playbookCandidateStatusLabel,
  procedureObservationClusterActionLabel,
  procedureObservationClusterStatusLabel,
  skillCandidateGate,
  skillCandidateOriginLabel,
  skillCandidateStatusLabel,
  skillDuplicateDecisionLabel,
} from "./skill-library-utils.js";

export function ProcedureObservationClusterCard({
  cluster,
  busyAction,
  onCreateProtocolCandidate,
  onCreatePlaybookCandidate,
  t,
}: {
  readonly cluster: ProcedureObservationCluster;
  readonly busyAction: string;
  readonly onCreateProtocolCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onCreatePlaybookCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const canCreateProtocol = cluster.channelId && cluster.routeKind === "channel_protocol" &&
    cluster.status === "ready_for_review" && cluster.recommendedAction === "create_channel_protocol_candidate" &&
    cluster.routeBlockers.length === 0;
  const canCreatePlaybook = cluster.channelId && cluster.routeKind === "playbook" &&
    cluster.status === "ready_for_review" && cluster.recommendedAction === "create_playbook_candidate" &&
    cluster.routeBlockers.length === 0;
  const protocolAction = `cluster:${cluster.id}:protocol`;
  const playbookAction = `cluster:${cluster.id}:playbook`;
  return (
    <article className="settings-skill-candidate-card settings-skill-review-queue-card" data-review-kind="clusters">
      <div className="settings-skill-candidate-main">
        <div className="settings-skill-candidate-title">
          <span>
            <small>{t("Repeated approaches")}</small>
            <strong>{cluster.title}</strong>
            <small>{candidateRouteKindLabel(cluster.routeKind, t)}</small>
          </span>
          <StatusIndicator label={procedureObservationClusterStatusLabel(cluster.status, t)} tone={clusterStatusTone(cluster.status)} />
        </div>
        <p>{cluster.summary}</p>
        <div className="settings-skill-candidate-meta">
          <span>{t("Suggested next step")}: {procedureObservationClusterActionLabel(cluster.recommendedAction, t)}</span>
          <span>{t("Observed")}: {cluster.observationCount}</span>
          <span>{t("Usefulness")}: {cluster.reusableScore}</span>
          <span>{t("Updated {time}", { time: formatDateTime(cluster.lastObservedAt) })}</span>
        </div>
        <InspectorSection className="settings-skill-review-details" title={t("Why this was grouped")}>
          <div className="settings-skill-candidate-gates">
            <DetailValue label={t("Technical ID")}><code>{cluster.id}</code></DetailValue>
            <DetailValue label={t("When it applies")}>
              <SkillTokenList values={cluster.positiveTriggers} emptyLabel={t("No positive triggers")} />
            </DetailValue>
            <DetailValue label={t("Needs attention")}>
              <SkillTokenList values={cluster.routeBlockers.map((blocker) => candidateRouteBlockerLabel(blocker, t))} emptyLabel={t("No blockers")} />
            </DetailValue>
          </div>
        </InspectorSection>
      </div>
      {canCreateProtocol || canCreatePlaybook ? (
        <div className="settings-skill-candidate-actions">
          {canCreateProtocol ? (
            <Button
              size="sm"
              variant="primary"
              leadingIcon={<BookOpen size={14} />}
              loading={busyAction === protocolAction}
              loadingLabel={t("Loading...")}
              disabled={Boolean(busyAction) && busyAction !== protocolAction}
              onClick={() => onCreateProtocolCandidate(cluster)}
            >
              {t("Turn into channel rules")}
            </Button>
          ) : null}
          {canCreatePlaybook ? (
            <Button
              size="sm"
              variant="primary"
              leadingIcon={<BookOpen size={14} />}
              loading={busyAction === playbookAction}
              loadingLabel={t("Loading...")}
              disabled={Boolean(busyAction) && busyAction !== playbookAction}
              onClick={() => onCreatePlaybookCandidate(cluster)}
            >
              {t("Turn into channel flow")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function PlaybookCandidateCard({
  candidate,
  channelName,
  readOnly,
  busyAction,
  onReview,
  t,
}: {
  readonly candidate: ChannelPlaybookCandidate;
  readonly channelName: string;
  readonly readOnly: boolean;
  readonly busyAction: string;
  readonly onReview: (candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const approveAction = `playbook:${candidate.id}:approve`;
  const rejectAction = `playbook:${candidate.id}:reject`;
  const canReview = candidate.status === "draft";
  return (
    <article className="settings-skill-candidate-card settings-skill-review-queue-card" data-review-kind="playbooks">
      <div className="settings-skill-candidate-main">
        <div className="settings-skill-candidate-title">
          <span><small>{t("Channel flows")}</small><strong>{candidate.title}</strong><small>{channelName}</small></span>
          <StatusIndicator label={playbookCandidateStatusLabel(candidate.status, t)} tone={playbookStatusTone(candidate.status)} />
        </div>
        <p>{candidate.summary}</p>
        <div className="settings-skill-candidate-meta">
          <span>{t("Intended outcome")}: {candidate.normalizedGoal}</span>
          <span>{t("Why suggested")}: {candidate.reason}</span>
          <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
        </div>
        <InspectorSection className="settings-skill-review-details" title={t("Flow details")}>
          <div className="settings-skill-candidate-gates">
            <DetailValue label={t("Technical ID")}><code>{candidate.id}</code></DetailValue>
            <DetailValue label={t("Steps")}><SkillTokenList values={candidate.procedureSteps.map((step) => step.title)} emptyLabel={t("No procedure steps")} /></DetailValue>
            <DetailValue label={t("How to verify")}><SkillTokenList values={candidate.validationSteps.map((step) => step.title)} emptyLabel={t("No validation steps")} /></DetailValue>
            <DetailValue label={t("When it applies")}><SkillTokenList values={candidate.positiveTriggers} emptyLabel={t("No positive triggers")} /></DetailValue>
            <DetailValue label={t("When not to use")}><SkillTokenList values={candidate.negativeTriggers} emptyLabel={t("No avoid triggers")} /></DetailValue>
            <DetailValue label={t("Reference records")}><SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} /></DetailValue>
          </div>
        </InspectorSection>
      </div>
      {!readOnly ? (
        <div className="settings-skill-candidate-actions">
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<CheckCircle2 size={14} />}
            loading={busyAction === approveAction}
            loadingLabel={t("Loading...")}
            disabled={!canReview || (Boolean(busyAction) && busyAction !== approveAction)}
            onClick={() => onReview(candidate, "approve")}
          >{t("Enable flow")}</Button>
          <Button
            size="sm"
            variant="danger"
            leadingIcon={<Archive size={14} />}
            loading={busyAction === rejectAction}
            loadingLabel={t("Loading...")}
            disabled={!canReview || (Boolean(busyAction) && busyAction !== rejectAction)}
            onClick={() => onReview(candidate, "reject")}
          >{t("Ignore flow")}</Button>
        </div>
      ) : null}
    </article>
  );
}

export function SkillCandidateReviewCard({
  candidate,
  readOnly,
  busyAction,
  onAdopt,
  onReview,
  t,
}: {
  readonly candidate: SkillCandidate;
  readonly readOnly: boolean;
  readonly busyAction: string;
  readonly onAdopt: (candidateId: string) => void;
  readonly onReview: (candidateId: string, action: SkillCandidateReviewAction) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const gate = skillCandidateGate(candidate, t);
  const adoptAction = `candidate:${candidate.id}:adopt`;
  const rejectAction = `candidate:${candidate.id}:reject`;
  const canReject = !isTerminalSkillCandidateStatus(candidate.status);
  const canAdopt = (candidate.status === "pending" || candidate.status === "needs_edit" || candidate.status === "approved_for_draft") &&
    !gate.approvalBlocked && !gate.draftBlocked;
  return (
    <article className="settings-skill-candidate-card settings-skill-review-queue-card" data-review-kind="skill_candidates">
      <div className="settings-skill-candidate-main">
        <div className="settings-skill-candidate-title">
          <span><small>{t("Skills to review")}</small><strong>{candidate.title}</strong><small>{skillCandidateOriginLabel(candidate.origin, t)}</small></span>
          <StatusIndicator label={skillCandidateStatusLabel(candidate.status, t)} tone={skillCandidateStatusTone(candidate.status)} />
        </div>
        <p>{candidate.summary}</p>
        <div className="settings-skill-candidate-meta">
          <span>{t("Similarity check")}: {skillDuplicateDecisionLabel(candidate.duplicateAnalysis.decision, t)}</span>
          <span>{t("Similarity")}: {Math.round(candidate.duplicateAnalysis.similarityScore * 100)}%</span>
          <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
        </div>
        <InspectorSection className="settings-skill-review-details" title={t("Why this was suggested")}>
          <div className="settings-skill-candidate-gates">
            <DetailValue label={t("Technical ID")}><code>{candidate.id}</code></DetailValue>
            <DetailValue label={t("Publish checks")}><SkillTokenList values={gate.labels} emptyLabel={t("Draft gates clear")} /></DetailValue>
            <DetailValue label={t("Reference records")}><SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} /></DetailValue>
          </div>
        </InspectorSection>
      </div>
      {!readOnly ? (
        <div className="settings-skill-candidate-actions">
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<CheckCircle2 size={14} />}
            loading={busyAction === adoptAction}
            loadingLabel={t("Loading...")}
            disabled={!canAdopt || (Boolean(busyAction) && busyAction !== adoptAction)}
            onClick={() => onAdopt(candidate.id)}
          >{t("Adopt and edit")}</Button>
          {canReject ? (
            <Button
              size="sm"
              variant="danger"
              leadingIcon={<Archive size={14} />}
              loading={busyAction === rejectAction}
              loadingLabel={t("Loading...")}
              disabled={Boolean(busyAction) && busyAction !== rejectAction}
              onClick={() => onReview(candidate.id, "reject")}
            >{t("Ignore")}</Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function DetailValue({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return <span><small>{label}</small>{children}</span>;
}

function clusterStatusTone(status: ProcedureObservationCluster["status"]): StatusTone {
  if (status === "ready_for_review") return "warning";
  if (status === "blocked") return "danger";
  if (status === "collecting") return "info";
  return "neutral";
}

function playbookStatusTone(status: ChannelPlaybookCandidate["status"]): StatusTone {
  if (status === "active") return "success";
  if (status === "draft" || status === "stale") return "warning";
  return "neutral";
}

function skillCandidateStatusTone(status: SkillCandidate["status"]): StatusTone {
  if (status === "published") return "success";
  if (status === "rejected" || status === "expired") return "neutral";
  if (status === "needs_edit") return "warning";
  return "info";
}
