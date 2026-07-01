import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  Archive,
  Code2,
  FileCheck2,
  FileText,
  Globe2,
  History,
  ListChecks,
  LocateFixed,
  Play,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { previewArtifactContent } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { ProposedPlanArtifact } from "../../../types.js";
import {
  createDockPageEntry,
  EvidencePage,
  FilesPage,
  MessageBodyRenderer,
  popDockPage,
  pushDockPage,
  resetDockStack,
  ReviewQueuePage,
  RightDockShell,
  ToolPlaceholderPage,
  type DockEvidenceGroupView,
  type DockFileItem,
  type DockPageKind,
  type DockPageStackEntry,
  type DockReviewArtifactRef,
  type DockReviewCodeLine,
  type DockReviewFilter,
  type DockReviewInlineNote,
  type DockReviewItem,
  type DockSurfaceKind,
  type RightDockPageManifest,
} from "../../../shared/conversation/index.js";
import { reviewNeedsAction } from "./projections.js";

export interface WorkspaceRightDockForcedDetail {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly node: ReactNode;
}

export interface WorkspaceRightDockPageRequest {
  readonly page: DockPageKind;
  readonly nonce: number;
}

export interface WorkspaceRightDockProps {
  readonly surface: DockSurfaceKind;
  readonly open: boolean;
  readonly collapsed?: boolean;
  readonly ariaLabel: string;
  readonly className?: string;
  readonly cwd?: string;
  readonly launcherTitle: string;
  readonly launcherSubtitle?: string;
  readonly reviewItems: readonly DockReviewItem[];
  readonly evidenceGroups: readonly DockEvidenceGroupView[];
  readonly fileItems: readonly DockFileItem[];
  readonly proposedPlans?: readonly ProposedPlanArtifact[];
  readonly proposedPlansLoading?: boolean;
  readonly proposedPlansError?: string;
  readonly currentPlanThreadId?: string;
  readonly planActionBusyId?: string;
  readonly includeActivity?: boolean;
  readonly activityNode?: ReactNode;
  readonly activityCount?: number;
  readonly actions?: ReactNode;
  readonly forcedDetail?: WorkspaceRightDockForcedDetail;
  readonly pageRequest?: WorkspaceRightDockPageRequest;
  readonly onPageRequestConsumed?: (nonce: number) => void;
  readonly onClose?: () => void;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  readonly onOpenPlanSource?: (plan: ProposedPlanArtifact) => void;
  readonly onSavePlan?: (plan: ProposedPlanArtifact) => void;
  readonly onRefinePlan?: (plan: ProposedPlanArtifact) => void;
  readonly onAcceptPlan?: (plan: ProposedPlanArtifact) => void;
  readonly onConvertPlan?: (plan: ProposedPlanArtifact) => void;
  readonly onArchivePlan?: (plan: ProposedPlanArtifact) => void;
}

export function WorkspaceRightDock({
  surface,
  open,
  collapsed,
  ariaLabel,
  className,
  cwd,
  launcherTitle,
  launcherSubtitle,
  reviewItems,
  evidenceGroups,
  fileItems,
  proposedPlans = [],
  proposedPlansLoading = false,
  proposedPlansError = "",
  currentPlanThreadId,
  planActionBusyId = "",
  includeActivity = false,
  activityNode,
  activityCount = 0,
  actions,
  forcedDetail,
  pageRequest,
  onPageRequestConsumed,
  onClose,
  onCollapsedChange,
  onOpenPlanSource,
  onSavePlan,
  onRefinePlan,
  onAcceptPlan,
  onConvertPlan,
  onArchivePlan,
}: WorkspaceRightDockProps): JSX.Element | null {
  const { t } = useI18n();
  const [stack, setStack] = useState<readonly DockPageStackEntry[]>([]);
  const [reviewFilter, setReviewFilter] = useState<DockReviewFilter>("all");
  const [planScope, setPlanScope] = useState<"thread" | "channel">("thread");
  const [planStatusFilter, setPlanStatusFilter] = useState<"current" | "all" | ProposedPlanArtifact["status"]>("current");
  const [artifactPreviewByReviewId, setArtifactPreviewByReviewId] = useState<Readonly<Record<string, DockReviewItem["codePreview"]>>>({});
  const browserGroups = useMemo(
    () => evidenceGroups.filter((group) => group.id === "browser"),
    [evidenceGroups],
  );
  const terminalGroups = useMemo(
    () => evidenceGroups.filter((group) => group.id === "shell"),
    [evidenceGroups],
  );
  const browserEvidenceCount = browserGroups.reduce((count, group) => count + group.items.length, 0);
  const terminalEvidenceCount = terminalGroups.reduce((count, group) => count + group.items.length, 0);
  const evidenceCount = evidenceGroups.reduce((count, group) => count + group.items.length, 0);
  const visiblePlanCount = proposedPlans.filter((plan) => plan.status !== "archived").length;
  const enrichedReviewItems = useMemo(() => reviewItems.map((item) => {
    const preview = artifactPreviewByReviewId[item.id];
    if (!preview) {
      return item;
    }
    return {
      ...item,
      codePreview: item.codePreview ?? preview,
      pathLabel: item.pathLabel ?? preview.pathLabel,
      stats: item.stats ?? preview.stats,
    };
  }), [artifactPreviewByReviewId, reviewItems]);
  const reviewActionCount = enrichedReviewItems.filter(reviewNeedsAction).length;
  const detailNodeById = useMemo(() => {
    const map = new Map<string, ReactNode>();
    for (const item of enrichedReviewItems) {
      map.set(`review:${item.id}`, (
        <DockReviewItemDetail item={item} cwd={cwd} />
      ));
    }
    for (const group of evidenceGroups) {
      for (const item of group.items) {
        map.set(`evidence:${item.id}`, (
          <DockEvidenceItemDetail
            groupLabel={group.label}
            item={item}
            labels={{
              group: t("Group"),
              summary: t("Summary"),
              source: t("Source"),
              time: t("Time"),
            }}
          />
        ));
      }
    }
    for (const item of fileItems) {
      map.set(`file:${item.id}`, (
        <DockFileItemDetail
          item={item}
          labels={{
            type: t("Type"),
            path: t("Path"),
            status: t("Status"),
          }}
        />
      ));
    }
    for (const plan of proposedPlans) {
      map.set(`plan:${plan.id}`, (
        <DockProposedPlanDetail
          plan={plan}
          cwd={cwd}
          busy={planActionBusyId === plan.id}
          onOpenSource={onOpenPlanSource}
          onSave={onSavePlan}
          onRefine={onRefinePlan}
          onAccept={onAcceptPlan}
          onConvert={onConvertPlan}
          onArchive={onArchivePlan}
        />
      ));
    }
    if (forcedDetail) {
      map.set(forcedDetail.id, forcedDetail.node);
    }
    return map;
  }, [
    cwd,
    enrichedReviewItems,
    evidenceGroups,
    fileItems,
    forcedDetail,
    onAcceptPlan,
    onArchivePlan,
    onConvertPlan,
    onOpenPlanSource,
    onRefinePlan,
    onSavePlan,
    planActionBusyId,
    proposedPlans,
    t,
  ]);
  const effectiveStack = forcedDetail
    ? [createDockPageEntry({
      page: "detail",
      title: forcedDetail.title,
      subtitle: forcedDetail.subtitle,
      sourceId: forcedDetail.id,
    })]
    : stack;

  useEffect(() => {
    setStack(resetDockStack());
  }, [surface]);

  useEffect(() => {
    if (!open) {
      setStack(resetDockStack());
    }
  }, [open]);

  useEffect(() => {
    setArtifactPreviewByReviewId({});
  }, [cwd]);

  useEffect(() => {
    if (!cwd) {
      setArtifactPreviewByReviewId({});
      return;
    }
    const candidates = reviewItems.filter((item) => item.artifactRef && !item.codePreview && !artifactPreviewByReviewId[item.id]);
    if (candidates.length === 0) {
      return;
    }
    let cancelled = false;
    void Promise.all(candidates.slice(0, 8).map(async (item) => {
      const artifactRef = item.artifactRef;
      if (!artifactRef) {
        return undefined;
      }
      try {
        const response = await previewArtifactContent(cwd, artifactRef.id, 96_000);
        if (!response.text) {
          return undefined;
        }
        return [item.id, codePreviewFromArtifact(artifactRef, response.text, response.kind, response.truncated)] as const;
      } catch {
        return undefined;
      }
    })).then((entries) => {
      if (cancelled) {
        return;
      }
      const nextEntries = entries.filter((entry): entry is readonly [string, NonNullable<DockReviewItem["codePreview"]>] => Boolean(entry));
      if (nextEntries.length === 0) {
        return;
      }
      setArtifactPreviewByReviewId((current) => ({
        ...current,
        ...Object.fromEntries(nextEntries),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [artifactPreviewByReviewId, cwd, reviewItems]);

  function pushPage(entry: DockPageStackEntry): void {
    if (forcedDetail) {
      return;
    }
    setStack((current) => pushDockPage(current, entry));
  }

  function pushDetail(sourceId: string, title: string, subtitle?: string): void {
    pushPage(createDockPageEntry({
      page: "detail",
      title,
      subtitle,
      sourceId,
    }));
  }

  const pages = useMemo<readonly RightDockPageManifest[]>(() => {
    const manifests: RightDockPageManifest[] = [
      {
      id: "review",
      label: t("Review workbench"),
      icon: <ListChecks size={16} />,
      launcherItem: {
        description: t("Changes, risks, evidence gaps, and approval gates"),
        count: reviewActionCount,
        statusLabel: reviewActionCount > 0 ? t("{count} items to inspect", { count: reviewActionCount }) : t("Clean"),
        severity: reviewActionCount > 0 ? "warning" : "neutral",
      },
      render: () => (
        <ReviewQueuePage
          items={enrichedReviewItems}
          activeFilter={reviewFilter}
          filters={[
            { id: "all", label: t("All") },
            { id: "needs_action", label: t("Needs action") },
            { id: "risk", label: t("Risk") },
            { id: "runtime", label: t("Runtime") },
            { id: "files", label: t("Changes") },
          ]}
          emptyTitle={t("No code review items")}
          emptyDescription={t("Changed files, failed runs, evidence gaps, and approval gates will appear here.")}
          needsActionLabel={t("Pending")}
          trackedLabel={t("Tracked")}
          blockerLabel={t("Blocker")}
          sendReviewLabel={t("Send review")}
          clearReviewLabel={t("Clear")}
          detailEmptyTitle={t("Select a review item")}
          detailEmptyDescription={t("Choose an item to inspect code, fallback state, or approval context.")}
          detailPresentation="accordion"
          renderItemDetail={(item) => <DockReviewItemDetail item={item} cwd={cwd} compact />}
          onFilterChange={setReviewFilter}
        />
      ),
    },
    {
      id: "plans",
      label: t("Plans"),
      icon: <History size={16} />,
      launcherItem: {
        description: t("Thread and channel proposed-plan history"),
        count: visiblePlanCount,
        statusLabel: proposedPlansLoading
          ? t("Loading")
          : visiblePlanCount > 0
            ? t("{count} plans", { count: visiblePlanCount })
            : t("No plans"),
        severity: proposedPlansError ? "warning" : visiblePlanCount > 0 ? "info" : "neutral",
      },
      render: () => (
        <PlanHistoryPage
          plans={proposedPlans}
          currentThreadId={currentPlanThreadId}
          loading={proposedPlansLoading}
          error={proposedPlansError}
          scope={planScope}
          statusFilter={planStatusFilter}
          busyPlanId={planActionBusyId}
          onScopeChange={setPlanScope}
          onStatusFilterChange={setPlanStatusFilter}
          onOpenPlan={(plan) => pushDetail(`plan:${plan.id}`, plan.title, proposedPlanSubtitle(plan, t))}
          onOpenSource={onOpenPlanSource}
        />
      ),
    },
    {
      id: "evidence",
      label: t("Evidence"),
      icon: <Search size={16} />,
      launcherItem: {
        description: t("Runs, approvals, files, and source evidence"),
        count: evidenceCount,
        statusLabel: evidenceCount > 0 ? t("{count} evidence items", { count: evidenceCount }) : t("No evidence yet"),
        severity: evidenceCount > 0 ? "info" : "neutral",
      },
      render: () => (
        <EvidencePage
          groups={evidenceGroups}
          emptyTitle={t("No evidence yet")}
          emptyDescription={t("Real run, approval, file, and source evidence will appear here.")}
          onOpenItem={(itemId) => {
            const item = evidenceGroups.flatMap((group) => group.items).find((candidate) => candidate.id === itemId);
            if (item) {
              pushDetail(`evidence:${item.id}`, item.title, item.sourceLabel);
            }
          }}
        />
      ),
    },
    {
      id: "files",
      label: t("Files"),
      icon: <FileText size={16} />,
      launcherItem: {
        description: t("Attachments, references, artifacts, and changes"),
        count: fileItems.length,
        statusLabel: fileItems.length > 0 ? t("{count} files", { count: fileItems.length }) : t("No files"),
        severity: fileItems.length > 0 ? "info" : "neutral",
      },
      render: () => (
        <FilesPage
          items={fileItems}
          emptyTitle={t("No files")}
          emptyDescription={t("Attachments, references, artifacts, and changes will appear here.")}
          kindLabels={{
            attachment: t("Attachment"),
            reference: t("Reference"),
            artifact: t("Artifact"),
            change: t("Change"),
          }}
          statusLabels={{
            available: t("Available"),
            generated: t("Generated"),
            changed: t("Changed"),
            missing: t("Missing"),
          }}
          onOpenItem={(itemId) => {
            const item = fileItems.find((candidate) => candidate.id === itemId);
            if (item) {
              pushDetail(`file:${item.id}`, item.name, item.pathLabel);
            }
          }}
        />
      ),
    },
    ];
    if (includeActivity) {
      manifests.push({
        id: "activity",
        label: t("Activity"),
        icon: <Activity size={16} />,
        launcherItem: {
          description: t("Channel activity and collaboration state"),
          count: activityCount,
          statusLabel: activityCount > 0 ? t("{count} active signals", { count: activityCount }) : t("No activity"),
          severity: activityCount > 0 ? "info" : "neutral",
        },
        render: () => (
          <ToolPlaceholderPage
            title={t("No activity yet")}
            description={t("Channel activity and collaboration state will appear here.")}
          >
            {activityNode ?? null}
          </ToolPlaceholderPage>
        ),
      });
    }
    manifests.push({
      id: "browser",
      label: t("Browser"),
      icon: <Globe2 size={16} />,
      launcherItem: {
        description: t("Search and browser evidence"),
        count: browserEvidenceCount,
        statusLabel: browserEvidenceCount > 0 ? t("{count} browser items", { count: browserEvidenceCount }) : t("No browser evidence"),
        severity: browserEvidenceCount > 0 ? "info" : "neutral",
      },
      render: () => (
        <EvidencePage
          groups={browserGroups}
          emptyTitle={t("No browser evidence")}
          emptyDescription={t("Browser and web search evidence appears only after real tool evidence exists.")}
          onOpenItem={(itemId) => {
            const item = browserGroups.flatMap((group) => group.items).find((candidate) => candidate.id === itemId);
            if (item) {
              pushDetail(`evidence:${item.id}`, item.title, item.sourceLabel);
            }
          }}
        />
      ),
    });
    manifests.push({
      id: "terminal",
      label: t("Terminal"),
      icon: <SquareTerminal size={16} />,
      launcherItem: {
        description: t("Shell snapshots and terminal evidence"),
        count: terminalEvidenceCount,
        statusLabel: terminalEvidenceCount > 0 ? t("{count} terminal items", { count: terminalEvidenceCount }) : t("No terminal evidence"),
        severity: terminalEvidenceCount > 0 ? "info" : "neutral",
      },
      render: () => (
        <EvidencePage
          groups={terminalGroups}
          emptyTitle={t("No terminal evidence")}
          emptyDescription={t("Terminal output appears only when a real shell snapshot is linked.")}
          onOpenItem={(itemId) => {
            const item = terminalGroups.flatMap((group) => group.items).find((candidate) => candidate.id === itemId);
            if (item) {
              pushDetail(`evidence:${item.id}`, item.title, item.sourceLabel);
            }
          }}
        />
      ),
    });
    manifests.push({
      id: "detail",
      label: t("Detail"),
      hiddenFromLauncher: true,
      render: (entry) => (
        <div className="right-dock-detail">
          {entry.sourceId ? detailNodeById.get(entry.sourceId) : null}
          {entry.sourceId && detailNodeById.has(entry.sourceId) ? null : (
            <ToolPlaceholderPage
              title={entry.title}
              description={t("This detail is no longer available.")}
            />
          )}
        </div>
      ),
    });
    return manifests;
  }, [
    activityCount,
    activityNode,
    browserEvidenceCount,
    browserGroups,
    detailNodeById,
    evidenceCount,
    evidenceGroups,
    fileItems,
    includeActivity,
    enrichedReviewItems,
    currentPlanThreadId,
    onOpenPlanSource,
    planActionBusyId,
    planScope,
    planStatusFilter,
    proposedPlans,
    proposedPlansError,
    proposedPlansLoading,
    reviewActionCount,
    reviewFilter,
    t,
    terminalEvidenceCount,
    terminalGroups,
    visiblePlanCount,
  ]);

  useEffect(() => {
    if (!open || forcedDetail || !pageRequest) {
      return;
    }
    const manifest = pages.find((candidate) => candidate.id === pageRequest.page);
    if (!manifest?.launcherItem || manifest.hiddenFromLauncher || manifest.launcherItem.disabled) {
      return;
    }
    setStack([
      createDockPageEntry({
        page: pageRequest.page,
        title: manifest.label,
        subtitle: manifest.launcherItem.statusLabel,
      }),
    ]);
    onPageRequestConsumed?.(pageRequest.nonce);
  }, [forcedDetail, onPageRequestConsumed, open, pageRequest, pages]);

  return (
    <RightDockShell
      surface={surface}
      open={open}
      collapsed={collapsed}
      ariaLabel={ariaLabel}
      stack={effectiveStack}
      pages={pages}
      launcherTitle={launcherTitle}
      launcherSubtitle={launcherSubtitle}
      actions={actions}
      closeLabel={t("Close")}
      collapseLabel={t("Collapse")}
      expandLabel={t("Expand")}
      backLabel={t("Back")}
      className={className}
      onClose={onClose}
      onCollapsedChange={onCollapsedChange}
      onNavigate={pushPage}
      onBack={() => {
        if (forcedDetail) {
          onClose?.();
          return;
        }
        setStack((current) => popDockPage(current));
      }}
    />
  );
}

type PlanStatusFilter = "current" | "all" | ProposedPlanArtifact["status"];

function PlanHistoryPage({
  plans,
  currentThreadId,
  loading,
  error,
  scope,
  statusFilter,
  busyPlanId,
  onScopeChange,
  onStatusFilterChange,
  onOpenPlan,
  onOpenSource,
}: {
  readonly plans: readonly ProposedPlanArtifact[];
  readonly currentThreadId?: string;
  readonly loading: boolean;
  readonly error: string;
  readonly scope: "thread" | "channel";
  readonly statusFilter: PlanStatusFilter;
  readonly busyPlanId: string;
  readonly onScopeChange: (scope: "thread" | "channel") => void;
  readonly onStatusFilterChange: (filter: PlanStatusFilter) => void;
  readonly onOpenPlan: (plan: ProposedPlanArtifact) => void;
  readonly onOpenSource?: (plan: ProposedPlanArtifact) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [agentFilter, setAgentFilter] = useState("all");
  const [goalFilter, setGoalFilter] = useState("all");
  const scopedPlans = useMemo(() => {
    const items = plans.filter((plan) => {
      if (scope === "thread" && currentThreadId && plan.threadId !== currentThreadId) {
        return false;
      }
      if (scope === "thread" && !currentThreadId) {
        return false;
      }
      if (statusFilter === "current" && plan.status !== "draft" && plan.status !== "accepted") {
        return false;
      }
      if (statusFilter !== "current" && statusFilter !== "all" && plan.status !== statusFilter) {
        return false;
      }
      const agentId = plan.ownerAgentId ?? plan.sourceAgentId ?? "";
      if (agentFilter !== "all" && agentId !== agentFilter) {
        return false;
      }
      if (goalFilter !== "all" && (plan.goalId ?? "") !== goalFilter) {
        return false;
      }
      return true;
    });
    return [...items].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id)
    );
  }, [agentFilter, currentThreadId, goalFilter, plans, scope, statusFilter]);
  const agentOptions = useMemo(() => uniquePlanFilterOptions(plans, (plan) => plan.ownerAgentId ?? plan.sourceAgentId), [plans]);
  const goalOptions = useMemo(() => uniquePlanFilterOptions(plans, (plan) => plan.goalId), [plans]);

  return (
    <div className="right-dock-plans-page">
      <div className="right-dock-page-header">
        <div className="right-dock-page-header-row">
          <History size={15} />
          <span className="right-dock-page-title">
            <strong>{t("Plan history")}</strong>
            <small>{scope === "thread" ? t("This thread") : t("This channel")}</small>
          </span>
          <span className="right-dock-row-state tone-info">{scopedPlans.length}</span>
        </div>
        <div className="right-dock-page-filters">
          <div className="right-dock-filter-row" aria-label={t("Plan scope")}>
            <button className={scope === "thread" ? "right-dock-filter active" : "right-dock-filter"} type="button" onClick={() => onScopeChange("thread")}>
              {t("This thread")}
            </button>
            <button className={scope === "channel" ? "right-dock-filter active" : "right-dock-filter"} type="button" onClick={() => onScopeChange("channel")}>
              {t("This channel")}
            </button>
          </div>
          <div className="right-dock-plan-select-row">
            <label>
              <span>{t("Status")}</span>
              <select value={statusFilter} onChange={(event) => onStatusFilterChange(event.target.value as PlanStatusFilter)} aria-label={t("Plan status")}>
                <option value="current">{t("Current")}</option>
                <option value="all">{t("All")}</option>
                <option value="draft">{t("Draft")}</option>
                <option value="accepted">{t("Accepted")}</option>
                <option value="superseded">{t("Superseded")}</option>
                <option value="archived">{t("Archived")}</option>
              </select>
            </label>
            <label>
              <span>{t("Agent")}</span>
              <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} aria-label={t("Plan agent")}>
                <option value="all">{t("All")}</option>
                {agentOptions.map((agentId) => <option key={agentId} value={agentId}>{agentId}</option>)}
              </select>
            </label>
            <label>
              <span>{t("Goal")}</span>
              <select value={goalFilter} onChange={(event) => setGoalFilter(event.target.value)} aria-label={t("Plan goal")}>
                <option value="all">{t("All")}</option>
                {goalOptions.map((goalId) => <option key={goalId} value={goalId}>{goalId}</option>)}
              </select>
            </label>
          </div>
        </div>
      </div>
      {loading ? (
        <ToolPlaceholderPage title={t("Loading plans")} description={t("Plan history is loading.")} />
      ) : error ? (
        <ToolPlaceholderPage title={t("Plan history unavailable")} description={error} />
      ) : scopedPlans.length === 0 ? (
        <ToolPlaceholderPage title={t("No plans")} description={t("Draft, accepted, superseded, and archived plans will appear here.")} />
      ) : (
        <div className="right-dock-section right-dock-plan-list">
          {scopedPlans.map((plan) => (
            <div key={plan.id} className={busyPlanId === plan.id ? "right-dock-plan-row busy" : "right-dock-plan-row"}>
              <button className="right-dock-row right-dock-plan-main" type="button" onClick={() => onOpenPlan(plan)}>
                <span className={`right-dock-row-dot ${planStatusTone(plan.status)}`} />
                <span className="right-dock-row-copy">
                  <strong>{plan.title}</strong>
                  <small>{proposedPlanSubtitle(plan, t)}</small>
                </span>
                <span className={`right-dock-row-state ${planStatusTone(plan.status)}`}>{proposedPlanStatusLabel(plan.status, t)}</span>
              </button>
              <button className="right-dock-icon-button right-dock-plan-source-button" type="button" onClick={() => onOpenSource?.(plan)} disabled={!plan.sourceMessageId} aria-label={t("Open source")} title={plan.sourceMessageId ? t("Open source") : t("Source unavailable")}>
                <LocateFixed size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DockProposedPlanDetail({
  plan,
  cwd,
  busy,
  onOpenSource,
  onSave,
  onRefine,
  onAccept,
  onConvert,
  onArchive,
}: {
  readonly plan: ProposedPlanArtifact;
  readonly cwd?: string;
  readonly busy: boolean;
  readonly onOpenSource?: (plan: ProposedPlanArtifact) => void;
  readonly onSave?: (plan: ProposedPlanArtifact) => void;
  readonly onRefine?: (plan: ProposedPlanArtifact) => void;
  readonly onAccept?: (plan: ProposedPlanArtifact) => void;
  readonly onConvert?: (plan: ProposedPlanArtifact) => void;
  readonly onArchive?: (plan: ProposedPlanArtifact) => void;
}): JSX.Element {
  const { t } = useI18n();
  const archived = plan.status === "archived";
  const accepted = plan.status === "accepted";

  return (
    <article className="right-dock-plan-detail">
      <header className="right-dock-review-detail-hero">
        <span className="right-dock-review-kicker"><FileCheck2 size={14} /> {t("Proposed plan")}</span>
        <h3>{plan.title}</h3>
        <div className="right-dock-review-badges">
          <span className={`status-${plan.status}`}>{proposedPlanStatusLabel(plan.status, t)}</span>
          <span>{planVersionLabel(plan, t)}</span>
          {plan.goalId ? <span>{t("Goal")}: {plan.goalId}</span> : null}
        </div>
      </header>
      <div className="right-dock-plan-action-row">
        <button className="secondary-button compact-button" type="button" onClick={() => onOpenSource?.(plan)} disabled={!plan.sourceMessageId || busy}>
          <LocateFixed size={14} />
          {t("Open source")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onSave?.(plan)} disabled={archived || busy}>
          <Save size={14} />
          {t("Save")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onRefine?.(plan)} disabled={archived || busy}>
          <RefreshCw size={14} />
          {t("Refine")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onConvert?.(plan)} disabled={archived || busy}>
          <Workflow size={14} />
          {t("Convert")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onAccept?.(plan)} disabled={archived || accepted || busy}>
          <Play size={14} />
          {t("Implement")}
        </button>
        <button className="secondary-button compact-button danger" type="button" onClick={() => onArchive?.(plan)} disabled={archived || busy}>
          <Archive size={14} />
          {t("Archive")}
        </button>
      </div>
      <dl className="right-dock-detail-list">
        <div>
          <dt>{t("Thread")}</dt>
          <dd>{plan.threadId}</dd>
        </div>
        {plan.sourceMessageId ? (
          <div>
            <dt>{t("Source message")}</dt>
            <dd>{plan.sourceMessageId}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("Updated")}</dt>
          <dd>{formatCompactPlanDate(plan.updatedAt)}</dd>
        </div>
        {plan.acceptedWorkflowId ? (
          <div>
            <dt>{t("Workflow")}</dt>
            <dd>{plan.acceptedWorkflowId}</dd>
          </div>
        ) : null}
      </dl>
      <section className="right-dock-plan-markdown" aria-label={t("Plan body")}>
        <MessageBodyRenderer text={plan.bodyMarkdown} cwd={cwd} compact />
      </section>
    </article>
  );
}

function uniquePlanFilterOptions(
  plans: readonly ProposedPlanArtifact[],
  readValue: (plan: ProposedPlanArtifact) => string | undefined,
): readonly string[] {
  return [...new Set(plans.map(readValue).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
}

function proposedPlanSubtitle(plan: ProposedPlanArtifact, t: (key: string, values?: Record<string, string | number>) => string): string {
  const parts = [
    plan.goalId ? t("Goal") : plan.channelId ? t("Channel") : t("Thread"),
    plan.ownerAgentId ?? plan.sourceAgentId,
    planVersionLabel(plan, t),
    formatCompactPlanDate(plan.updatedAt),
  ].filter(Boolean);
  return parts.join(" · ");
}

function proposedPlanStatusLabel(status: ProposedPlanArtifact["status"], t: (key: string) => string): string {
  switch (status) {
    case "accepted":
      return t("Accepted");
    case "superseded":
      return t("Superseded");
    case "archived":
      return t("Archived");
    case "draft":
    default:
      return t("Draft");
  }
}

function planStatusTone(status: ProposedPlanArtifact["status"]): "tone-info" | "tone-warning" | "tone-danger" | "tone-muted" {
  if (status === "accepted") {
    return "tone-info";
  }
  if (status === "superseded") {
    return "tone-warning";
  }
  if (status === "archived") {
    return "tone-muted";
  }
  return "tone-info";
}

function planVersionLabel(plan: ProposedPlanArtifact, t: (key: string, values?: Record<string, string | number>) => string): string {
  return plan.version && plan.version > 0 ? t("v{version}", { version: plan.version }) : t("v1");
}

function formatCompactPlanDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DockReviewItemDetail({
  item,
  cwd,
  compact = false,
}: {
  readonly item: DockReviewItem;
  readonly cwd?: string;
  readonly compact?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const isApprovalGate = item.kind === "approval_gate";
  const hasPreview = Boolean(item.codePreview);
  const canLoadArtifactPreview = Boolean(!hasPreview && item.artifactRef && cwd);
  const showChangeFallback = item.kind === "code_change" && !hasPreview && !canLoadArtifactPreview;

  return (
    <article className={`right-dock-review-detail ${compact ? "compact" : ""} ${item.kind ?? "generic"}`}>
      {item.codePreview && !compact ? <DockReviewDetailTop item={item} preview={item.codePreview} /> : null}
      {item.codePreview ? <DockReviewCodePreview item={item} preview={item.codePreview} /> : null}
      {item.artifactRef && cwd && !hasPreview ? (
        <DockReviewArtifactPreview
          artifactRef={item.artifactRef}
          cwd={cwd}
          fallbackTitle={item.title}
          fallbackReason={item.reason}
          compact={compact}
        />
      ) : null}

      {showChangeFallback ? (
        <div className="right-dock-review-fallback-card" title={item.reason}>
          <span className="right-dock-review-fallback-icon"><Code2 size={14} /></span>
          <span className="right-dock-review-fallback-copy">
            <strong>{item.title}</strong>
            {item.reason ? <small>{item.reason}</small> : null}
          </span>
          <span className="right-dock-review-fallback-action">{t("Preview unavailable")}</span>
        </div>
      ) : null}

      {!hasPreview && !showChangeFallback && !canLoadArtifactPreview ? (
        <div className="right-dock-review-plain">
          <span className="right-dock-review-kicker">
            {isApprovalGate ? <ShieldCheck size={15} /> : <Code2 size={15} />}
            {reviewKindLabel(item.kind, t)}
          </span>
          <p>{item.reason}</p>
          {item.facts && item.facts.length > 0 ? (
            <div className="right-dock-review-facts compact" aria-label={t("Review facts")}>
              {item.facts.map((fact) => (
                <span key={`${fact.label}:${fact.value}`} className={fact.tone ? `tone-${fact.tone}` : undefined}>
                  <small>{fact.label}</small>
                  <strong>{fact.value}</strong>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {isApprovalGate ? (
        <div className="right-dock-review-approval-note">
          <ShieldCheck size={15} />
          <span>
            <strong>{t("Approval gate")}</strong>
            <small>{t("Approval happens in the approval surface. Review only shows the evidence.")}</small>
          </span>
        </div>
      ) : null}
    </article>
  );
}

function DockReviewDetailTop({
  item,
  preview,
}: {
  readonly item: DockReviewItem;
  readonly preview: NonNullable<DockReviewItem["codePreview"]>;
}): JSX.Element {
  const stats = item.stats ?? preview.stats ?? codePreviewStats(preview.lines);
  const minimap = reviewMinimapSegments(item, preview);
  return (
    <div className="right-dock-review-detail-top">
      <div className="right-dock-review-file-strip">
        <span className="right-dock-review-file-type">{fileTypeLabel(preview)}</span>
        <span className="right-dock-review-file-path">
          <strong>{preview.title || item.title}</strong>
          <small>{reviewDetailPathLabel(item, preview) || " "}</small>
        </span>
        {stats ? (
          <span className="right-dock-diff-stat">
            <span className="add">+{stats.additions}</span>
            <span className="del">-{stats.deletions}</span>
          </span>
        ) : null}
      </div>
      <div className="right-dock-review-minimap" aria-label="File review minimap">
        {minimap.map((segment) => (
          <span
            key={segment.id}
            className={`right-dock-review-mini ${segment.tone}`}
            title={segment.label}
            style={{ "--segment-fill": `${segment.fill}%` } as CSSProperties}
          />
        ))}
      </div>
      <div className="right-dock-review-mode-row" aria-label="Review display mode">
        <span className="right-dock-review-mode active">Unified</span>
        <span className="right-dock-review-mode">Split</span>
        <span className="right-dock-review-mode">Hide whitespace</span>
        <span className="right-dock-review-mode">只看 note</span>
      </div>
    </div>
  );
}

function DockReviewArtifactPreview({
  artifactRef,
  cwd,
  fallbackTitle,
  fallbackReason,
  compact = false,
}: {
  readonly artifactRef: DockReviewArtifactRef;
  readonly cwd: string;
  readonly fallbackTitle: string;
  readonly fallbackReason: string;
  readonly compact?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<DockReviewItem["codePreview"]>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPreview(undefined);
    void previewArtifactContent(cwd, artifactRef.id, 96_000).then((response) => {
      if (cancelled) {
        return;
      }
      if (response.text) {
        setPreview(codePreviewFromArtifact(artifactRef, response.text, response.kind, response.truncated));
        return;
      }
      setError(t("Preview unavailable"));
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
  }, [artifactRef, cwd, t]);

  if (loading) {
    return (
      <div className="right-dock-review-fallback-card loading" title={fallbackReason}>
        <span className="right-dock-review-fallback-icon"><Code2 size={14} /></span>
        <span className="right-dock-review-fallback-copy">
          <strong>{fallbackTitle}</strong>
          <small>{fallbackReason}</small>
        </span>
        <span className="right-dock-review-fallback-action">{t("Loading preview...")}</span>
      </div>
    );
  }

  if (preview) {
    const previewItem: DockReviewItem = {
      id: artifactRef.id,
      group: "files",
      severity: "info",
      status: "pending",
      kind: "code_change",
      title: fallbackTitle,
      reason: fallbackReason,
      pathLabel: artifactRef.path,
      stats: preview.stats,
    };
    return (
      <>
        {!compact ? <DockReviewDetailTop item={previewItem} preview={preview} /> : null}
        <DockReviewCodePreview item={previewItem} preview={preview} />
      </>
    );
  }

  return (
    <div className="right-dock-review-fallback-card" title={error || fallbackReason}>
      <span className="right-dock-review-fallback-icon"><Code2 size={14} /></span>
      <span className="right-dock-review-fallback-copy">
        <strong>{fallbackTitle}</strong>
        <small>{error || fallbackReason}</small>
      </span>
      <span className="right-dock-review-fallback-action">{t("Preview unavailable")}</span>
    </div>
  );
}

type DockReviewCodeRenderRow =
  | {
    readonly type: "fold";
    readonly id: string;
    readonly label: string;
  }
  | {
    readonly type: "line";
    readonly id: string;
    readonly line: DockReviewCodeLine;
    readonly note?: DockReviewInlineNote;
  };

interface ShikiHighlightedToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
}

function DockReviewCodePreview({
  item,
  preview,
}: {
  readonly item: DockReviewItem;
  readonly preview: NonNullable<DockReviewItem["codePreview"]>;
}): JSX.Element {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const primaryLabel = preview.title;
  const secondaryLabel = preview.pathLabel ?? preview.language;
  const stats = preview.stats ?? codePreviewStats(preview.lines);
  const notes = useMemo(() => inlineNotesForReviewItem(item, preview, t), [item, preview, t]);
  const rows = useMemo(() => codePreviewRenderRows(preview.lines, notes), [notes, preview.lines]);
  const highlightedLines = useShikiHighlightedCodeRows(preview, rows);

  useEffect(() => {
    setCollapsed(false);
  }, [item.id, preview.title]);

  return (
    <figure className={collapsed ? "right-dock-code-preview collapsed" : "right-dock-code-preview"} data-language={preview.language ?? "text"}>
      <figcaption title={preview.pathLabel ?? preview.title}>
        <button
          type="button"
          className="right-dock-code-preview-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("Expand code preview") : t("Collapse code preview")}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="right-dock-code-title">{primaryLabel}</span>
          {stats ? <span className="right-dock-code-stat"><span>+{stats.additions}</span><span>-{stats.deletions}</span></span> : null}
          {secondaryLabel ? <small>{secondaryLabel}</small> : null}
        </button>
      </figcaption>
      {!collapsed ? (
        <>
          <pre>
            {rows.map((row) => {
              if (row.type === "fold") {
                return (
                  <span key={row.id} className="right-dock-code-fold">
                    <button type="button" aria-label={t("Show previous context")}>⌃</button>
                    <span>{row.label}</span>
                    <button type="button" aria-label={t("Show next context")}>⌄</button>
                  </span>
                );
              }
              const note = row.note;
              return (
                <span key={row.id} className="right-dock-code-row-group">
                  <span className={[
                    "right-dock-code-line",
                    row.line.kind,
                    note ? "has-note" : "",
                    note?.severity === "blocker" ? "block-note" : "",
                  ].filter(Boolean).join(" ")}>
                    <span className="right-dock-code-number">{codeLineDisplayNumber(row.line)}</span>
                    <span className="right-dock-code-mark">{codeLineMark(row.line.kind)}</span>
                    <code>{renderCodeTokens(displayCodeLineText(row.line), highlightedLines[row.id])}</code>
                    <span className="right-dock-code-note-mark">{note ? "●" : ""}</span>
                  </span>
                  {note ? (
                    <span className={`right-dock-inline-note ${note.severity}`}>
                      <span className="right-dock-note-pill">{inlineNoteLabel(note)}</span>
                      <span>{note.body}</span>
                      {note.authorLabel ? <span className="right-dock-note-author">{note.authorLabel}</span> : null}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </pre>
          {preview.truncated ? <small className="right-dock-code-truncated">{t("Preview truncated")}</small> : null}
        </>
      ) : null}
    </figure>
  );
}

function useShikiHighlightedCodeRows(
  preview: NonNullable<DockReviewItem["codePreview"]>,
  rows: readonly DockReviewCodeRenderRow[],
): Readonly<Record<string, readonly ShikiHighlightedToken[]>> {
  const language = useMemo(() => shikiLanguageForPreview(preview), [preview]);
  const source = useMemo(() => rows.map((row) => (row.type === "line" ? displayCodeLineText(row.line) : "")).join("\n"), [rows]);
  const rowIds = useMemo(() => rows.map((row) => (row.type === "line" ? row.id : "")), [rows]);
  const [highlightedLines, setHighlightedLines] = useState<Readonly<Record<string, readonly ShikiHighlightedToken[]>>>({});

  useEffect(() => {
    const code = source.trim();
    if (!code || language === "text") {
      setHighlightedLines({});
      return;
    }
    let cancelled = false;
    void tokenizeWithShiki(source, language).then((tokenLines) => {
      if (cancelled) {
        return;
      }
      const next: Record<string, readonly ShikiHighlightedToken[]> = {};
      tokenLines.forEach((tokens, index) => {
        const rowId = rowIds[index];
        if (rowId && tokens.length > 0) {
          next[rowId] = tokens;
        }
      });
      setHighlightedLines(next);
    }, () => {
      if (!cancelled) {
        setHighlightedLines({});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [language, rowIds, source]);

  return highlightedLines;
}

async function tokenizeWithShiki(
  source: string,
  language: string,
): Promise<readonly (readonly ShikiHighlightedToken[])[]> {
  const { codeToTokens } = await import("shiki");
  const result = await codeToTokens(source, {
    lang: language as Parameters<typeof codeToTokens>[1]["lang"],
    theme: "github-dark-default",
  });
  const tokenLines = "tokens" in result ? result.tokens : [];
  return tokenLines.map((line) => line.map((token) => ({
    content: token.content,
    color: token.color,
    fontStyle: token.fontStyle,
  })));
}

function shikiLanguageForPreview(preview: NonNullable<DockReviewItem["codePreview"]>): string {
  const explicit = normalizeShikiLanguage(preview.language);
  if (explicit && explicit !== "diff") {
    return explicit;
  }
  const source = `${preview.title} ${preview.pathLabel ?? ""}`;
  const extensionMatch = /(?:^|[^\w.-])[\w.-]+\.([a-z0-9]+)\b/iu.exec(source);
  return normalizeShikiLanguage(extensionMatch?.[1]) ?? explicit ?? "text";
}

function normalizeShikiLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const languages: Readonly<Record<string, string>> = {
    bash: "bash",
    css: "css",
    diff: "diff",
    htm: "html",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    markdown: "markdown",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    sh: "bash",
    ts: "typescript",
    tsx: "tsx",
    txt: "text",
    yml: "yaml",
    yaml: "yaml",
    zsh: "bash",
  };
  return languages[normalized] ?? normalized;
}

function reviewMinimapSegments(
  item: DockReviewItem,
  preview: NonNullable<DockReviewItem["codePreview"]>,
): readonly {
  readonly id: string;
  readonly tone: "green" | "amber" | "red" | "gray";
  readonly label: string;
  readonly fill: number;
}[] {
  const stats = item.stats ?? preview.stats ?? codePreviewStats(preview.lines);
  const total = Math.max(1, (stats?.additions ?? 0) + (stats?.deletions ?? 0));
  const additionFill = Math.min(94, Math.max(24, Math.round(((stats?.additions ?? 0) / total) * 100)));
  const riskFill = item.severity === "warning" || item.status === "pending" ? 42 : 18;
  const blockerFill = item.severity === "danger" || item.status === "blocked" || item.status === "failed" ? 34 : 14;
  return [
    { id: "changes", tone: "green", label: "Changed lines", fill: additionFill },
    { id: "risk", tone: "amber", label: "Review notes and risks", fill: riskFill },
    { id: "blocker", tone: "red", label: "Blockers", fill: blockerFill },
    { id: "fallback", tone: "gray", label: "Fallback previews", fill: item.artifactRef ? 34 : 0 },
  ];
}

function inlineNotesForReviewItem(
  item: DockReviewItem,
  preview: NonNullable<DockReviewItem["codePreview"]>,
  t: (key: string, values?: Readonly<Record<string, string | number>>) => string,
): readonly DockReviewInlineNote[] {
  if (preview.inlineNotes && preview.inlineNotes.length > 0) {
    return preview.inlineNotes;
  }
  const anchor = preferredInlineNoteAnchor(preview.lines, item);
  if (!anchor) {
    return [];
  }
  if (item.severity === "danger" || item.status === "blocked" || item.status === "failed") {
    return [{
      id: `${item.id}:blocker-note`,
      severity: "blocker",
      label: "BLOCKER",
      authorLabel: item.sourceLabel,
      body: item.reason,
      oldLineNumber: anchor.oldLineNumber,
      newLineNumber: anchor.newLineNumber,
      lineKind: anchor.kind,
    }];
  }
  if (item.severity === "warning" || item.kind === "approval_gate") {
    return [{
      id: `${item.id}:risk-note`,
      severity: "risk",
      label: "RISK",
      authorLabel: item.sourceLabel,
      body: item.reason,
      oldLineNumber: anchor.oldLineNumber,
      newLineNumber: anchor.newLineNumber,
      lineKind: anchor.kind,
    }];
  }
  if (item.kind === "code_change" && item.status === "pending") {
    return [{
      id: `${item.id}:qa-note`,
      severity: "suggestion",
      label: "QA",
      authorLabel: item.sourceLabel,
      body: t("Check whether this change matches the current goal and code context."),
      oldLineNumber: anchor.oldLineNumber,
      newLineNumber: anchor.newLineNumber,
      lineKind: anchor.kind,
    }];
  }
  return [];
}

function preferredInlineNoteAnchor(
  lines: readonly DockReviewCodeLine[],
  item: DockReviewItem,
): DockReviewCodeLine | undefined {
  if (item.severity === "danger" || item.status === "blocked" || item.status === "failed") {
    return lines.find((line) => line.kind === "delete") ?? lines.find((line) => line.kind === "add") ?? lines.find((line) => line.kind === "context");
  }
  return lines.find((line) => line.kind === "add") ?? lines.find((line) => line.kind === "delete") ?? lines.find((line) => line.kind === "context");
}

function codePreviewRenderRows(
  lines: readonly DockReviewCodeLine[],
  notes: readonly DockReviewInlineNote[],
): readonly DockReviewCodeRenderRow[] {
  const rows: DockReviewCodeRenderRow[] = [];
  let previousOldLine: number | undefined;
  let previousNewLine: number | undefined;
  lines.forEach((line, index) => {
    if (line.kind === "hunk") {
      const hunkStart = hunkStartLineNumbers(line.text);
      const foldCount = unchangedLineGap(previousOldLine, previousNewLine, hunkStart?.oldLineNumber, hunkStart?.newLineNumber);
      if (foldCount > 8) {
        rows.push({
          type: "fold",
          id: `fold:${index}:${foldCount}`,
          label: `${foldCount} unchanged lines`,
        });
      }
    }
    rows.push({
      type: "line",
      id: `line:${index}:${line.oldLineNumber ?? ""}:${line.newLineNumber ?? ""}:${line.text}`,
      line,
      note: noteForLine(line, notes),
    });
    if (line.oldLineNumber !== undefined) {
      previousOldLine = line.oldLineNumber;
    }
    if (line.newLineNumber !== undefined) {
      previousNewLine = line.newLineNumber;
    }
  });
  return rows;
}

function hunkStartLineNumbers(text: string): { readonly oldLineNumber: number; readonly newLineNumber: number } | undefined {
  const previewMarkerMatch = /^#(\d+)$/u.exec(text.trim());
  if (previewMarkerMatch) {
    const lineNumber = Number(previewMarkerMatch[1]);
    return {
      oldLineNumber: lineNumber,
      newLineNumber: lineNumber,
    };
  }
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/u.exec(text);
  if (!match) {
    return undefined;
  }
  return {
    oldLineNumber: Number(match[1]),
    newLineNumber: Number(match[2]),
  };
}

function unchangedLineGap(
  previousOldLine: number | undefined,
  previousNewLine: number | undefined,
  nextOldLine: number | undefined,
  nextNewLine: number | undefined,
): number {
  if (nextOldLine === undefined || nextNewLine === undefined) {
    return 0;
  }
  if (previousOldLine === undefined && previousNewLine === undefined) {
    return Math.max(0, Math.min(nextOldLine, nextNewLine) - 1);
  }
  const oldGap = previousOldLine === undefined ? 0 : nextOldLine - previousOldLine - 1;
  const newGap = previousNewLine === undefined ? 0 : nextNewLine - previousNewLine - 1;
  return Math.max(0, Math.min(oldGap || newGap, newGap || oldGap));
}

function noteForLine(
  line: DockReviewCodeLine,
  notes: readonly DockReviewInlineNote[],
): DockReviewInlineNote | undefined {
  return notes.find((note) => {
    if (note.lineKind && note.lineKind !== line.kind) {
      return false;
    }
    if (note.oldLineNumber !== undefined && note.oldLineNumber !== line.oldLineNumber) {
      return false;
    }
    if (note.newLineNumber !== undefined && note.newLineNumber !== line.newLineNumber) {
      return false;
    }
    return note.oldLineNumber !== undefined || note.newLineNumber !== undefined || note.lineKind === line.kind;
  });
}

function inlineNoteLabel(note: DockReviewInlineNote): string {
  if (note.label) {
    return note.label;
  }
  if (note.severity === "blocker") {
    return "BLOCKER";
  }
  if (note.severity === "risk") {
    return "RISK";
  }
  return "QA";
}

function renderCodeTokens(text: string, shikiTokens: readonly ShikiHighlightedToken[] | undefined): ReactNode {
  if (shikiTokens && shikiTokens.length > 0) {
    return shikiTokens.map((token, index) => (
      <span
        key={`${index}:${token.content}`}
        className="right-dock-code-token shiki"
        style={{
          color: token.color,
          fontStyle: token.fontStyle && (token.fontStyle & 1) ? "italic" : undefined,
          fontWeight: token.fontStyle && (token.fontStyle & 2) ? 700 : undefined,
          textDecoration: token.fontStyle && (token.fontStyle & 4) ? "underline" : undefined,
        }}
      >
        {token.content}
      </span>
    ));
  }
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|implements|import|interface|let|new|null|readonly|return|switch|throw|true|try|type|undefined|var|while)\b|[A-Za-z_$][\w$]*(?=\s*\())/gu;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token = match[0];
    const className = /^["'`]/u.test(token)
      ? "str"
      : /\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|implements|import|interface|let|new|null|readonly|return|switch|throw|true|try|type|undefined|var|while)\b/u.test(token)
        ? "kw"
        : "fn";
    nodes.push(<span key={`${match.index}:${token}`} className={`right-dock-code-token ${className}`}>{token}</span>);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes.length > 0 ? nodes : text;
}

function codePreviewFromArtifact(
  artifactRef: DockReviewArtifactRef,
  text: string,
  kind: string,
  truncated: boolean,
): NonNullable<DockReviewItem["codePreview"]> {
  const language = kind === "diff" ? "diff" : kind === "json" ? "json" : kind === "log" ? "log" : "text";
  const lines = textToCodeLines(text, language);
  const stats = codePreviewStats(lines);
  return {
    title: artifactRef.title ?? artifactRef.path ?? artifactRef.id,
    language,
    pathLabel: artifactRef.path,
    lines: lines.slice(0, 180),
    stats,
    truncated: truncated || lines.length > 180,
  };
}

function textToCodeLines(text: string, language: string): readonly DockReviewCodeLine[] {
  if (language !== "diff") {
    return text.split(/\r?\n/u).map((line, index) => ({
      kind: "context",
      text: line || " ",
      lineNumber: index + 1,
      oldLineNumber: index + 1,
      newLineNumber: index + 1,
    }));
  }
  const lines: DockReviewCodeLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  text.split(/\r?\n/u).forEach((line, index) => {
    const kind = diffLineKind(line);
    if (kind === "hunk") {
      const hunkStart = hunkStartLineNumbers(line);
      oldLine = hunkStart?.oldLineNumber;
      newLine = hunkStart?.newLineNumber;
      lines.push({ kind, text: line || " ", lineNumber: index + 1 });
      return;
    }
    if (kind === "add") {
      lines.push({ kind, text: line || " ", lineNumber: index + 1, newLineNumber: newLine });
      if (newLine !== undefined) {
        newLine += 1;
      }
      return;
    }
    if (kind === "delete") {
      lines.push({ kind, text: line || " ", lineNumber: index + 1, oldLineNumber: oldLine });
      if (oldLine !== undefined) {
        oldLine += 1;
      }
      return;
    }
    if (kind === "context") {
      lines.push({ kind, text: line || " ", lineNumber: index + 1, oldLineNumber: oldLine, newLineNumber: newLine });
      if (oldLine !== undefined) {
        oldLine += 1;
      }
      if (newLine !== undefined) {
        newLine += 1;
      }
      return;
    }
    lines.push({ kind, text: line || " ", lineNumber: index + 1 });
  });
  return lines;
}

function diffLineKind(line: string): DockReviewCodeLine["kind"] {
  if (/^#\d+$/u.test(line.trim())) {
    return "hunk";
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "add";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "delete";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ")) {
    return "meta";
  }
  return "context";
}

function reviewKindLabel(kind: DockReviewItem["kind"], t: (key: string, values?: Readonly<Record<string, string | number>>) => string): string {
  switch (kind) {
    case "approval_gate":
      return t("Approval gate");
    case "code_change":
      return t("Code change");
    case "runtime_issue":
      return t("Runtime issue");
    case "evidence_gap":
      return t("Evidence gap");
    case "message_issue":
      return t("Message issue");
    case "protocol_signal":
      return t("Protocol signal");
    default:
      return t("Review item");
  }
}

function codeLineNumber(value: number | undefined, kind: NonNullable<DockReviewItem["codePreview"]>["lines"][number]["kind"]): string {
  if (kind === "hunk" || kind === "meta") {
    return "";
  }
  return value === undefined ? "" : String(value);
}

function codeLineDisplayNumber(line: DockReviewCodeLine): string {
  if (line.kind === "hunk" || line.kind === "meta") {
    return "";
  }
  if (line.kind === "delete") {
    return codeLineNumber(line.oldLineNumber, line.kind);
  }
  if (line.kind === "add") {
    return codeLineNumber(line.newLineNumber, line.kind);
  }
  return codeLineNumber(line.newLineNumber ?? line.oldLineNumber ?? line.lineNumber, line.kind);
}

function codeLineMark(kind: NonNullable<DockReviewItem["codePreview"]>["lines"][number]["kind"]): string {
  if (kind === "add") {
    return "+";
  }
  if (kind === "delete") {
    return "-";
  }
  if (kind === "command") {
    return "$";
  }
  if (kind === "hunk") {
    return "";
  }
  return "";
}

function displayCodeLineText(line: DockReviewCodeLine): string {
  if ((line.kind === "add" || line.kind === "delete") && /^[+-]/u.test(line.text)) {
    return line.text.slice(1) || " ";
  }
  if (line.kind === "context" && line.text.startsWith(" ")) {
    return line.text.slice(1) || " ";
  }
  return line.text || " ";
}

function codePreviewStats(lines: readonly DockReviewCodeLine[]): { readonly additions: number; readonly deletions: number } | undefined {
  const additions = lines.filter((line) => line.kind === "add").length;
  const deletions = lines.filter((line) => line.kind === "delete").length;
  return additions > 0 || deletions > 0 ? { additions, deletions } : undefined;
}

function reviewDetailTitle(item: DockReviewItem): string {
  return item.codePreview?.title || fileNameFromPath(item.pathLabel) || item.title;
}

function reviewDetailSubtitle(item: DockReviewItem): string | undefined {
  const path = item.codePreview?.pathLabel ?? item.pathLabel;
  return path ? directoryNameFromPath(path) : item.sourceLabel;
}

function reviewDetailPathLabel(
  item: DockReviewItem,
  preview: NonNullable<DockReviewItem["codePreview"]>,
): string | undefined {
  const path = preview.pathLabel ?? item.pathLabel;
  if (!path) {
    return preview.language ? preview.language.toUpperCase() : undefined;
  }
  const directory = directoryNameFromPath(path);
  return directory || path;
}

function fileTypeLabel(preview: NonNullable<DockReviewItem["codePreview"]>): string {
  const path = preview.pathLabel ?? preview.title;
  const ext = path.split(".").pop()?.trim();
  if (ext && ext.length > 0 && ext.length <= 5 && ext !== path) {
    return ext.toUpperCase();
  }
  return (preview.language ?? "TXT").slice(0, 4).toUpperCase();
}

function fileNameFromPath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function directoryNameFromPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return undefined;
  }
  return parts.slice(0, -1).join("/");
}

function DockEvidenceItemDetail({
  groupLabel,
  item,
  labels,
}: {
  readonly groupLabel: string;
  readonly item: DockEvidenceGroupView["items"][number];
  readonly labels: {
    readonly group: string;
    readonly summary: string;
    readonly source: string;
    readonly time: string;
  };
}): JSX.Element {
  return (
    <dl className="right-dock-detail-list">
      <div>
        <dt>{labels.group}</dt>
        <dd>{groupLabel}</dd>
      </div>
      {item.summary ? (
        <div>
          <dt>{labels.summary}</dt>
          <dd>{item.summary}</dd>
        </div>
      ) : null}
      {item.sourceLabel ? (
        <div>
          <dt>{labels.source}</dt>
          <dd>{item.sourceLabel}</dd>
        </div>
      ) : null}
      {item.timestampLabel ? (
        <div>
          <dt>{labels.time}</dt>
          <dd>{item.timestampLabel}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function DockFileItemDetail({
  item,
  labels,
}: {
  readonly item: DockFileItem;
  readonly labels: {
    readonly type: string;
    readonly path: string;
    readonly status: string;
  };
}): JSX.Element {
  return (
    <dl className="right-dock-detail-list">
      <div>
        <dt>{labels.type}</dt>
        <dd>{item.kind}</dd>
      </div>
      {item.pathLabel ? (
        <div>
          <dt>{labels.path}</dt>
          <dd>{item.pathLabel}</dd>
        </div>
      ) : null}
      {item.status ? (
        <div>
          <dt>{labels.status}</dt>
          <dd>{item.status}</dd>
        </div>
      ) : null}
    </dl>
  );
}
