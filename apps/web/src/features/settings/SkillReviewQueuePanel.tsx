import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Search } from "lucide-react";
import {
  Badge,
  InlineFeedback,
  Input,
  Select,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from "../../shared/ui/index.js";
import type {
  Channel,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
} from "../../types.js";
import {
  PlaybookCandidateCard,
  ProcedureObservationClusterCard,
  SkillCandidateReviewCard,
} from "./SkillReviewQueueCards.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import {
  projectSkillReviewQueue,
  type SkillEvolutionQueueView,
  type SkillReviewQueueFilter,
  type SkillReviewQueueSortMode,
} from "./skill-review-queue-model.js";

export function SkillReviewQueuePanel({
  view,
  skillCandidates,
  clusters,
  playbookCandidates,
  channels,
  loading,
  busyAction,
  error,
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
  readonly busyAction: string;
  readonly error: string;
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
  const projection = useMemo(() => projectSkillReviewQueue({
    view,
    skillCandidates,
    clusters,
    playbookCandidates,
    channels,
    activeFilter,
    searchQuery,
    sortMode,
  }), [activeFilter, channels, clusters, playbookCandidates, searchQuery, skillCandidates, sortMode, view]);
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
          <Input
            containerClassName="settings-skill-search"
            prefix={<Search size={15} />}
            size="sm"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder={t("Search AI evolution")}
            aria-label={t("Search AI evolution")}
          />
          {toolbarAfterSearch}
          <Select
            containerClassName="settings-skill-evolution-sort-select"
            size="sm"
            value={sortMode}
            onChange={(event) => setSortMode(event.currentTarget.value === "name" ? "name" : "updated")}
            aria-label={t("Sort AI evolution")}
          >
            <option value="updated">{t("Sort by updated")}</option>
            <option value="name">{t("Sort by name")}</option>
          </Select>
        </div>
      ) : null}
      <section
        className={`settings-skill-review-queue${projection.queueItems.length === 0 ? " is-empty" : ""}`}
        aria-label={sectionTitle}
        data-ui2-skill-review-queue=""
      >
        <header className="settings-skill-candidate-head settings-skill-review-queue-head">
          <span><CheckCircle2 size={15} /><strong>{sectionTitle}</strong></span>
          <small>{t("{count} evolution items", { count: projection.queueItems.length })}</small>
        </header>
        {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
        {projection.queueItems.length > 0 ? (
          <Tabs value={activeFilter} onValueChange={(value) => setActiveFilter(isQueueFilter(value) ? value : "all")}>
            <TabsList className="settings-skill-review-filters" appearance="contained" size="sm" aria-label={t("AI evolution filters")}>
              {filters.map((filter) => (
                <TabsTrigger key={filter.id} value={filter.id}>
                  <span>{filter.label}</span>
                  <Badge>{projection.counts[filter.id]}</Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
        {loading && projection.queueItems.length === 0 ? (
          <div className="settings-skill-review-loading" aria-label={t("Loading AI evolution...")}>
            {[0, 1, 2].map((index) => <Skeleton key={index} shape="block" width="100%" height={82} />)}
          </div>
        ) : projection.visibleItems.length > 0 ? (
          <div className="settings-skill-candidate-list settings-skill-review-queue-list">
            {projection.visibleItems.map((item) => {
              if (item.kind === "skill_candidates") {
                return <SkillCandidateReviewCard key={item.id} candidate={item.candidate} readOnly={view !== "pending"} busyAction={busyAction} onAdopt={onAdoptSkillCandidate} onReview={onReviewSkillCandidate} t={t} />;
              }
              if (item.kind === "clusters") {
                return <ProcedureObservationClusterCard key={item.id} cluster={item.cluster} busyAction={busyAction} onCreateProtocolCandidate={onCreateProtocolCandidate} onCreatePlaybookCandidate={onCreatePlaybookCandidate} t={t} />;
              }
              return <PlaybookCandidateCard key={item.id} candidate={item.candidate} channelName={projection.channelNames.get(item.candidate.channelId) ?? item.candidate.channelId} readOnly={view !== "pending"} busyAction={busyAction} onReview={onReviewPlaybookCandidate} t={t} />;
            })}
          </div>
        ) : null}
      </section>
    </>
  );
}

function isQueueFilter(value: string): value is SkillReviewQueueFilter {
  return value === "all" || value === "skill_candidates" || value === "clusters" || value === "playbooks";
}
