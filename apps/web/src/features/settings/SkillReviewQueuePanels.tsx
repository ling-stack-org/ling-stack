import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, BookOpen, CheckCircle2, Search } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  Channel,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
} from "../../types.js";
import { SelectControl } from "../../shared/components/SelectControl.js";
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
type SkillReviewQueueSortMode = "updated" | "name";
export type SkillEvolutionQueueView = "pending" | "generated" | "ignored";

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
  view,
  skillCandidates,
  clusters,
  playbookCandidates,
  channels,
  loading,
  saving,
  onAdoptSkillCandidate,
  onReviewSkillCandidate,
  onCreateProtocolCandidate,
  onCreatePlaybookCandidate,
  onReviewPlaybookCandidate,
  toolbarAfterSearch,
  t,
}: {
  readonly view: SkillEvolutionQueueView;
  readonly skillCandidates: readonly SkillCandidate[];
  readonly clusters: readonly ProcedureObservationCluster[];
  readonly playbookCandidates: readonly ChannelPlaybookCandidate[];
  readonly channels: readonly Channel[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onAdoptSkillCandidate: (candidateId: string) => void;
  readonly onReviewSkillCandidate: (candidateId: string, action: SkillCandidateReviewAction) => void;
  readonly onCreateProtocolCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onCreatePlaybookCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onReviewPlaybookCandidate: (candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction) => void;
  readonly toolbarAfterSearch?: ReactNode;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const [activeFilter, setActiveFilter] = useState<SkillReviewQueueFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<SkillReviewQueueSortMode>("updated");
  useEffect(() => {
    setActiveFilter("all");
    setSearchQuery("");
  }, [view]);
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name])), [channels]);
  const visibleSkillCandidates = useMemo(() => skillCandidates.filter((candidate) => {
    if (view === "pending") return isOpenSkillCandidateStatus(candidate.status);
    if (view === "ignored") return isTerminalSkillCandidateStatus(candidate.status) && candidate.status !== "published";
    return false;
  }), [skillCandidates, view]);
  const sortedClusters = useMemo(() => clusters.filter((cluster) => {
    if (view === "pending") return cluster.status === "ready_for_review";
    if (view === "ignored") return cluster.status === "blocked" || cluster.status === "routed_elsewhere";
    return false;
  }).sort((left, right) => {
    const statusRank: Record<ProcedureObservationCluster["status"], number> = {
      ready_for_review: 0,
      blocked: 1,
      collecting: 2,
      routed_elsewhere: 3,
    };
    const rank = statusRank[left.status] - statusRank[right.status];
    return rank !== 0 ? rank : right.lastObservedAt.localeCompare(left.lastObservedAt);
  }), [clusters, view]);
  const sortedPlaybookCandidates = useMemo(() => sortPlaybookCandidates(playbookCandidates.filter((candidate) => {
    if (view === "pending") return candidate.status === "draft";
    if (view === "generated") return candidate.status === "active";
    return candidate.status === "cancelled" || candidate.status === "stale";
  })), [playbookCandidates, view]);
  const queueItems = useMemo<readonly SkillReviewQueueListItem[]>(() => {
    const items: SkillReviewQueueListItem[] = [
      ...visibleSkillCandidates.map((candidate): SkillCandidateQueueItem => ({
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
    ];
    return items.sort((left, right) => sortMode === "name"
      ? skillReviewQueueItemTitle(left).localeCompare(skillReviewQueueItemTitle(right), undefined, { sensitivity: "base" })
      : right.updatedAt.localeCompare(left.updatedAt));
  }, [sortMode, visibleSkillCandidates, sortedClusters, sortedPlaybookCandidates]);
  const counts: Record<SkillReviewQueueFilter, number> = {
    all: queueItems.length,
    skill_candidates: visibleSkillCandidates.length,
    clusters: sortedClusters.length,
    playbooks: sortedPlaybookCandidates.length,
  };
  const filteredItems = activeFilter === "all"
    ? queueItems
    : queueItems.filter((item) => item.kind === activeFilter);
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleItems = normalizedSearchQuery
    ? filteredItems.filter((item) => skillReviewQueueSearchText(item, channelNames).includes(normalizedSearchQuery))
    : filteredItems;
  const filters: readonly { readonly id: SkillReviewQueueFilter; readonly label: string }[] = [
    { id: "all", label: t("All") },
    { id: "skill_candidates", label: t("Skills to review") },
    { id: "clusters", label: t("Repeated approaches") },
    { id: "playbooks", label: t("Channel flows") },
  ];
  const sectionTitle = view === "pending" ? t("Needs review") : view === "generated" ? t("Active channel flows") : t("Ignored history");

  return (
    <>
      {toolbarAfterSearch ? (
        <div className="settings-skill-library-toolbar settings-skill-library-toolbar--evolution-queue has-view-select">
          <label className="settings-skill-search">
            <Search size={15} />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("Search AI evolution")}
            />
          </label>
          {toolbarAfterSearch}
          <SelectControl
            variant="compact"
            containerClassName="settings-skill-evolution-sort-select"
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value === "name" ? "name" : "updated")}
            aria-label={t("Sort AI evolution")}
          >
            <option value="updated">{t("Sort by updated")}</option>
            <option value="name">{t("Sort by name")}</option>
          </SelectControl>
        </div>
      ) : null}
      <section className={`settings-skill-review-queue${queueItems.length === 0 ? " is-empty" : ""}`} aria-label={sectionTitle}>
      <header className="settings-skill-candidate-head settings-skill-review-queue-head">
        <span>
          <CheckCircle2 size={15} />
          <strong>{sectionTitle}</strong>
        </span>
        <small>{t("{count} evolution items", { count: queueItems.length })}</small>
      </header>
      {queueItems.length > 0 ? (
        <div className="settings-skill-review-filters" role="tablist" aria-label={t("AI evolution filters")}>
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
      ) : null}
      {visibleItems.length === 0 ? (
        <div className="compact-empty settings-skill-review-empty">
          {loading ? t("Loading AI evolution...") : activeFilter === "all" ? t("No evolution items need attention") : t("No evolution items in this filter")}
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
                    readOnly={view !== "pending"}
                    saving={saving}
                    onAdopt={onAdoptSkillCandidate}
                    onReview={onReviewSkillCandidate}
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
                    readOnly={view !== "pending"}
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
    </>
  );
}

function skillReviewQueueItemTitle(item: SkillReviewQueueListItem): string {
  switch (item.kind) {
    case "skill_candidates":
      return item.candidate.title;
    case "clusters":
      return item.cluster.title;
    case "playbooks":
      return item.candidate.title;
  }
}

function skillReviewQueueSearchText(
  item: SkillReviewQueueListItem,
  channelNames: ReadonlyMap<string, string>,
): string {
  switch (item.kind) {
    case "skill_candidates":
      return `${item.candidate.title} ${item.candidate.summary}`.toLocaleLowerCase();
    case "clusters":
      return `${item.cluster.title} ${item.cluster.summary}`.toLocaleLowerCase();
    case "playbooks":
      return `${item.candidate.title} ${item.candidate.summary} ${channelNames.get(item.candidate.channelId) ?? ""}`.toLocaleLowerCase();
  }
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
            <small>{t("Repeated approaches")}</small>
            <strong>{cluster.title}</strong>
            <small>{candidateRouteKindLabel(cluster.routeKind, t)}</small>
          </span>
          <span className={`settings-skill-candidate-status ${cluster.status}`}>{procedureObservationClusterStatusLabel(cluster.status, t)}</span>
        </div>
        <p>{cluster.summary}</p>
        <div className="settings-skill-candidate-meta">
          <span>{t("Suggested next step")}: {procedureObservationClusterActionLabel(cluster.recommendedAction, t)}</span>
          <span>{t("Observed")}: {cluster.observationCount}</span>
          <span>{t("Usefulness")}: {cluster.reusableScore}</span>
          <span>{t("Updated {time}", { time: formatDateTime(cluster.lastObservedAt) })}</span>
        </div>
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Why this was grouped")}</summary>
          <div className="settings-skill-candidate-gates">
            <span>
              <small>{t("Technical ID")}</small>
              <code>{cluster.id}</code>
            </span>
            <span>
              <small>{t("When it applies")}</small>
              <SkillTokenList values={cluster.positiveTriggers} emptyLabel={t("No positive triggers")} />
            </span>
            <span>
              <small>{t("Needs attention")}</small>
              <SkillTokenList values={cluster.routeBlockers.map((blocker) => candidateRouteBlockerLabel(blocker, t))} emptyLabel={t("No blockers")} />
            </span>
          </div>
        </details>
      </div>
      {canCreateProtocolCandidate ? (
        <div className="settings-skill-candidate-actions">
          <button className="primary-button compact-button" type="button" onClick={() => onCreateProtocolCandidate(cluster)} disabled={saving}>
            <BookOpen size={14} />
            {t("Turn into channel rules")}
          </button>
        </div>
      ) : null}
      {canCreatePlaybookCandidate ? (
        <div className="settings-skill-candidate-actions">
          <button className="primary-button compact-button" type="button" onClick={() => onCreatePlaybookCandidate(cluster)} disabled={saving}>
            <BookOpen size={14} />
            {t("Turn into channel flow")}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function PlaybookCandidateCard({
  candidate,
  channelName,
  readOnly,
  saving,
  onReview,
  t,
}: {
  readonly candidate: ChannelPlaybookCandidate;
  readonly channelName: string;
  readonly readOnly: boolean;
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
            <small>{t("Channel flows")}</small>
            <strong>{candidate.title}</strong>
            <small>{channelName}</small>
          </span>
          <span className={`settings-skill-candidate-status ${candidate.status}`}>{playbookCandidateStatusLabel(candidate.status, t)}</span>
        </div>
        <p>{candidate.summary}</p>
        <div className="settings-skill-candidate-meta">
          <span>{t("Intended outcome")}: {candidate.normalizedGoal}</span>
          <span>{t("Why suggested")}: {candidate.reason}</span>
          <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
        </div>
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Flow details")}</summary>
          <div className="settings-skill-candidate-gates">
            <span>
              <small>{t("Technical ID")}</small>
              <code>{candidate.id}</code>
            </span>
            <span>
              <small>{t("Steps")}</small>
              <SkillTokenList values={candidate.procedureSteps.map((step) => step.title)} emptyLabel={t("No procedure steps")} />
            </span>
            <span>
              <small>{t("How to verify")}</small>
              <SkillTokenList values={candidate.validationSteps.map((step) => step.title)} emptyLabel={t("No validation steps")} />
            </span>
            <span>
              <small>{t("When it applies")}</small>
              <SkillTokenList values={candidate.positiveTriggers} emptyLabel={t("No positive triggers")} />
            </span>
            <span>
              <small>{t("When not to use")}</small>
              <SkillTokenList values={candidate.negativeTriggers} emptyLabel={t("No avoid triggers")} />
            </span>
            <span>
              <small>{t("Reference records")}</small>
              <SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} />
            </span>
          </div>
        </details>
      </div>
      {!readOnly ? (
        <div className="settings-skill-candidate-actions">
          <button className="primary-button compact-button" type="button" onClick={() => onReview(candidate, "approve")} disabled={saving || !canReview}>
            <CheckCircle2 size={14} />
            {t("Enable flow")}
          </button>
          <button className="secondary-button danger compact-button" type="button" onClick={() => onReview(candidate, "reject")} disabled={saving || !canReview}>
            <Archive size={14} />
            {t("Ignore flow")}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function SkillCandidateReviewCard({
  candidate,
  readOnly,
  saving,
  onAdopt,
  onReview,
  t,
}: {
  readonly candidate: SkillCandidate;
  readonly readOnly: boolean;
  readonly saving: boolean;
  readonly onAdopt: (candidateId: string) => void;
  readonly onReview: (candidateId: string, action: SkillCandidateReviewAction) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const gate = skillCandidateGate(candidate, t);
  const canReject = !isTerminalSkillCandidateStatus(candidate.status);
  const canAdopt = (candidate.status === "pending" || candidate.status === "needs_edit" || candidate.status === "approved_for_draft") &&
    !gate.approvalBlocked && !gate.draftBlocked;
  return (
    <article className="settings-skill-candidate-card settings-skill-review-queue-card" data-review-kind="skill_candidates">
      <div className="settings-skill-candidate-main">
        <div className="settings-skill-candidate-title">
          <span>
            <small>{t("Skills to review")}</small>
            <strong>{candidate.title}</strong>
            <small>{skillCandidateOriginLabel(candidate.origin, t)}</small>
          </span>
          <SkillCandidateStatusPill candidate={candidate} t={t} />
        </div>
        <p>{candidate.summary}</p>
        <div className="settings-skill-candidate-meta">
          <span>{t("Similarity check")}: {skillDuplicateDecisionLabel(candidate.duplicateAnalysis.decision, t)}</span>
          <span>{t("Similarity")}: {Math.round(candidate.duplicateAnalysis.similarityScore * 100)}%</span>
          <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
        </div>
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Why this was suggested")}</summary>
          <div className="settings-skill-candidate-gates">
            <span>
              <small>{t("Technical ID")}</small>
              <code>{candidate.id}</code>
            </span>
            <span>
              <small>{t("Publish checks")}</small>
              <SkillTokenList values={gate.labels} emptyLabel={t("Draft gates clear")} />
            </span>
            <span>
              <small>{t("Reference records")}</small>
              <SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} />
            </span>
          </div>
        </details>
      </div>
      {!readOnly ? (
        <div className="settings-skill-candidate-actions">
          <button className="primary-button compact-button" type="button" onClick={() => onAdopt(candidate.id)} disabled={saving || !canAdopt}>
            <CheckCircle2 size={14} />
            {t("Adopt and edit")}
          </button>
          {canReject ? (
            <button className="secondary-button danger compact-button" type="button" onClick={() => onReview(candidate.id, "reject")} disabled={saving}>
              <Archive size={14} />
              {t("Ignore")}
            </button>
          ) : null}
        </div>
      ) : null}
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
