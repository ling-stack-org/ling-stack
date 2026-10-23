import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Code2,
  FileText,
  Globe2,
  History,
  MessageSquare,
  SquareTerminal,
} from "lucide-react";
import { getWorkspaceChanges, previewArtifactContent } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { ProposedPlanArtifact, WorkspaceChangesResponse } from "../../../types.js";
import type { WorkspaceChangeReview, WorkspaceFileCapabilityScope, WorkspaceFileCapabilityTarget } from "@ling-stack/contracts";
import { useWorkspaceRecovery } from "../../../shared/conversation/blocks/workspace-recovery-resource.js";
import {
  createDockPageEntry,
  EvidencePage,
  FilesPage,
  popDockPage,
  pushDockPage,
  resetDockStack,
  RightDockShell,
  ToolPlaceholderPage,
  type DockEvidenceGroupView,
  type DockFileItem,
  type DockPageKind,
  type DockPageStackEntry,
  type DockReviewItem,
  type DockSurfaceKind,
  type RightDockPageManifest,
} from "../../../shared/conversation/index.js";
import {
  PlanDetailPanel,
  PlanHistoryPage,
  proposedPlanSubtitle,
  type PlanStatusFilter,
} from "./PlanHistoryPage.js";
import { reviewNeedsAction } from "./projections.js";
import { WorkspaceTerminalPanel, type WorkspaceTerminalSession } from "../WorkspaceTerminalPanel.js";
import { WorkspaceChangeReviewPage } from "./WorkspaceChangeReviewPage.js";
import { DockReviewItemDetail } from "./DockReviewItemDetail.js";
import { codePreviewFromArtifact, fileNameFromPath } from "./DockReviewCodePreview.js";
import { DockEvidenceItemDetail } from "./DockEvidenceItemDetail.js";
import {
  DockFileItemDetail,
  DockWorkspaceFilePreview,
  workspaceFileDetailSourceId,
  workspaceFileTargetSubtitle,
} from "./DockFileItemDetail.js";

export interface WorkspaceRightDockForcedDetail {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly node: ReactNode;
}

export interface WorkspaceRightDockPageRequest {
  readonly page: DockPageKind;
  readonly nonce: number;
  readonly workspaceFile?: WorkspaceRightDockFileTarget;
  readonly workspaceReview?: WorkspaceRightDockReviewTarget;
}

export interface WorkspaceRightDockFileTarget {
  readonly localFile?: import("../../../../../desktop/shared/local-file-capabilities.js").DesktopLocalFilePreview;
  readonly cwd?: string;
  readonly path: string;
  readonly line?: number;
  readonly label?: string;
  readonly capabilityId?: string;
  readonly capabilityTarget?: WorkspaceFileCapabilityTarget;
  readonly capabilityScope?: WorkspaceFileCapabilityScope;
}

export interface WorkspaceRightDockReviewTarget {
  readonly baseline?: "head";
  readonly cwd: string;
  readonly runId?: string;
  readonly path?: string;
  readonly scope?: WorkspaceChangeReview["scope"];
  readonly review?: WorkspaceChangeReview;
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
  readonly terminalSession?: WorkspaceTerminalSession;
  readonly proposedPlans?: readonly ProposedPlanArtifact[];
  readonly proposedPlansLoading?: boolean;
  readonly proposedPlansError?: string;
  readonly externalError?: string;
  readonly includePlans?: boolean;
  readonly currentPlanThreadId?: string;
  readonly planActionBusyId?: string;
  readonly contextNode?: ReactNode;
  readonly contextLabel?: string;
  readonly contextDescription?: string;
  readonly contextCount?: number;
  readonly includeActivity?: boolean;
  readonly activityNode?: ReactNode;
  readonly activityCount?: number;
  readonly activityDescription?: string;
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
  terminalSession,
  proposedPlans = [],
  proposedPlansLoading = false,
  proposedPlansError = "",
  externalError = "",
  includePlans = true,
  currentPlanThreadId,
  planActionBusyId = "",
  contextNode,
  contextLabel,
  contextDescription,
  contextCount = 0,
  includeActivity = false,
  activityNode,
  activityCount = 0,
  activityDescription,
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
}: WorkspaceRightDockProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [stack, setStack] = useState<readonly DockPageStackEntry[]>([]);
  const [planScope, setPlanScope] = useState<"thread" | "channel">("thread");
  const [planStatusFilter, setPlanStatusFilter] = useState<PlanStatusFilter>("current");
  const [artifactPreviewByReviewId, setArtifactPreviewByReviewId] = useState<Readonly<Record<string, DockReviewItem["codePreview"]>>>({});
  const [requestedWorkspaceFile, setRequestedWorkspaceFile] = useState<{
    readonly nonce: number;
    readonly target: WorkspaceRightDockFileTarget;
  }>();
  const [requestedWorkspaceReview, setRequestedWorkspaceReview] = useState<WorkspaceRightDockReviewTarget>();
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChangesResponse>();
  const [workspaceChangesLoading, setWorkspaceChangesLoading] = useState(false);
  const [workspaceChangesError, setWorkspaceChangesError] = useState("");
  const [workspaceChangesRefreshKey, setWorkspaceChangesRefreshKey] = useState(0);
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
  const hasTerminalSession = Boolean(terminalSession);
  const hasContextPage = Boolean(contextNode);
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
  const codeChangeReviewItems = useMemo(
    () => enrichedReviewItems.filter((item) => item.group === "files"),
    [enrichedReviewItems],
  );
  const codeChangeActionCount = codeChangeReviewItems.filter(reviewNeedsAction).length;
  const effectiveReviewCwd = requestedWorkspaceReview?.cwd ?? cwd;
  const reviewFileCount = requestedWorkspaceReview?.review?.files.length ?? workspaceChanges?.files.length ?? codeChangeReviewItems.length;
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
              status: t("Status"),
              source: t("Source"),
              link: t("Link"),
              requestedUrl: t("Requested URL"),
              finalUrl: t("Final URL"),
              failureReason: t("Failure reason"),
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
    if (requestedWorkspaceFile && (requestedWorkspaceFile.target.localFile || requestedWorkspaceFile.target.cwd || cwd)) {
      map.set(workspaceFileDetailSourceId(requestedWorkspaceFile.nonce), (
        <DockWorkspaceFilePreview cwd={requestedWorkspaceFile.target.cwd ?? cwd ?? ""} target={requestedWorkspaceFile.target}
          onNavigateLocalFile={(localFile) => {
            const target = { ...requestedWorkspaceFile.target, path: localFile.path, line: localFile.line, localFile };
            setRequestedWorkspaceFile({ ...requestedWorkspaceFile, target });
            setStack([createDockPageEntry({ page: "detail", title: localFile.name, subtitle: localFile.path, sourceId: workspaceFileDetailSourceId(requestedWorkspaceFile.nonce) })]);
          }} />
      ));
    }
    for (const plan of proposedPlans) {
      map.set(`plan:${plan.id}`, (
        <PlanDetailPanel
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
    requestedWorkspaceFile,
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
  const reviewPageActive = open && effectiveStack.at(-1)?.page === "review";
  const scopedResource = useWorkspaceRecovery(effectiveReviewCwd, reviewPageActive ? requestedWorkspaceReview?.scope : undefined, requestedWorkspaceReview?.review?.revision);
  const scopedReview = useMemo(() => {
    const initial = requestedWorkspaceReview?.review;
    const updated = scopedResource.recovery?.review;
    if (!initial || !updated) return initial ?? updated;
    // Keep the card's disclosure boundary when refreshing Host evidence.
    const paths = new Set([...initial.coveredPaths, ...initial.files.map((file) => file.path)]);
    const files = updated.files.filter((file) => paths.has(file.path));
    const coveredPaths = updated.coveredPaths.filter((path) => paths.has(path));
    for (const file of initial.files) if (!coveredPaths.includes(file.path)) files.push({ ...file, state: "unavailable", additions: undefined, deletions: undefined, diff: undefined });
    const exact = updated.state === "exact" && files.every((file) => file.state === "exact");
    return { ...updated, files, coveredPaths, additions: exact ? files.reduce((sum, file) => sum + file.additions!, 0) : undefined,
      deletions: exact ? files.reduce((sum, file) => sum + file.deletions!, 0) : undefined, state: exact ? "exact" as const : "partial" as const };
  }, [requestedWorkspaceReview?.review, scopedResource.recovery?.review]);

  useEffect(() => {
    setStack(resetDockStack());
  }, [surface]);

  useEffect(() => {
    if (!open) {
      setStack(resetDockStack());
      setRequestedWorkspaceReview(undefined);
    }
  }, [open]);

  useEffect(() => {
    setArtifactPreviewByReviewId({});
    setRequestedWorkspaceFile(undefined);
  }, [cwd]);

  useEffect(() => {
    if (!reviewPageActive || !effectiveReviewCwd || requestedWorkspaceReview?.scope) {
      setWorkspaceChangesLoading(false);
      if (!effectiveReviewCwd) {
        setWorkspaceChanges(undefined);
        setWorkspaceChangesError("");
      }
      return;
    }
    let cancelled = false;
    setWorkspaceChanges((current) => current?.cwd === effectiveReviewCwd ? current : undefined);
    setWorkspaceChangesLoading(true);
    setWorkspaceChangesError("");
    void getWorkspaceChanges(effectiveReviewCwd, requestedWorkspaceReview?.baseline).then((response) => {
      if (!cancelled) {
        setWorkspaceChanges(response);
      }
    }, (error) => {
      if (!cancelled) {
        setWorkspaceChanges(undefined);
        setWorkspaceChangesError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!cancelled) {
        setWorkspaceChangesLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [effectiveReviewCwd, reviewPageActive, workspaceChangesRefreshKey, requestedWorkspaceReview?.baseline, requestedWorkspaceReview?.scope?.kind, requestedWorkspaceReview?.scope?.id]);

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
      ...(hasContextPage ? [{
        id: "context" as const,
        label: contextLabel ?? t("Context"),
        icon: <MessageSquare size={16} />,
        launcherItem: {
          description: contextDescription ?? t("Conversation context and workspace state"),
          count: contextCount,
          statusLabel: contextCount === 1 ? t("1 context item") : contextCount > 1 ? t("{count} context items", { count: contextCount }) : t("Context ready"),
          severity: contextCount > 0 ? "info" as const : "neutral" as const,
        },
        render: () => contextNode,
      }] : []),
      {
        id: "review",
        label: t("Review workbench"),
        icon: <Code2 size={16} />,
        launcherItem: {
          description: t("Changed files and diff previews"),
          count: reviewFileCount,
          statusLabel: workspaceChangesLoading && !workspaceChanges
            ? t("Loading")
            : reviewFileCount === 1 ? t("1 code change")
              : reviewFileCount > 1 ? t("{count} code changes", { count: reviewFileCount }) : t("No code changes"),
          severity: codeChangeActionCount > 0 ? "warning" : reviewFileCount > 0 ? "info" : "neutral",
        },
        render: () => (
          <WorkspaceChangeReviewPage
            cwd={effectiveReviewCwd}
            changes={workspaceChanges}
            review={scopedReview}
            scoped={Boolean(requestedWorkspaceReview?.scope)}
            loading={requestedWorkspaceReview?.scope ? scopedResource.status === "loading" : workspaceChangesLoading}
            error={requestedWorkspaceReview?.scope ? scopedResource.status === "unavailable" && !scopedReview ? t("Historical diff unavailable") : "" : workspaceChangesError || externalError}
            requestedPath={requestedWorkspaceReview?.path}
            onRefresh={requestedWorkspaceReview?.scope ? scopedResource.refresh : () => setWorkspaceChangesRefreshKey((current) => current + 1)}
          />
        ),
      },
      ...(includePlans ? [{
        id: "plans" as const,
        label: t("Plans"),
        icon: <History size={16} />,
        launcherItem: {
          description: surface === "channel" ? t("Thread and channel proposed-plan history") : t("Thread proposed-plan history"),
          count: visiblePlanCount,
          statusLabel: proposedPlansLoading
            ? t("Loading")
            : visiblePlanCount > 0
              ? visiblePlanCount === 1 ? t("1 plan") : t("{count} plans", { count: visiblePlanCount })
              : t("No plans"),
          severity: proposedPlansError ? "warning" as const : visiblePlanCount > 0 ? "info" as const : "neutral" as const,
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
            allowChannelScope={surface === "channel"}
            onScopeChange={setPlanScope}
            onStatusFilterChange={setPlanStatusFilter}
            onOpenPlan={(plan) => pushDetail(`plan:${plan.id}`, plan.title, proposedPlanSubtitle(plan, t))}
            onOpenSource={onOpenPlanSource}
          />
        ),
      }] : []),
    {
      id: "files",
      label: t("Files"),
      icon: <FileText size={16} />,
      launcherItem: {
        description: t("Attachments, references, artifacts, and changes"),
        count: fileItems.length,
        statusLabel: externalError ? t("Needs attention") : fileItems.length === 1 ? t("1 file") : fileItems.length > 1 ? t("{count} files", { count: fileItems.length }) : t("No files"),
        severity: externalError ? "warning" : fileItems.length > 0 ? "info" : "neutral",
      },
      render: () => (
        <FilesPage
          items={fileItems}
          emptyTitle={t("No files")}
          emptyDescription={t("Attachments, references, artifacts, and changes will appear here.")}
          groupFallbackLabel={t("Files")}
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
          error={externalError}
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
      const resolvedActivityDescription = activityDescription ?? (surface === "channel"
        ? t("Channel activity and collaboration state")
        : t("Conversation context and workspace state"));
      manifests.push({
        id: "activity",
        label: t("Activity"),
        icon: <Activity size={16} />,
        launcherItem: {
          description: resolvedActivityDescription,
          count: activityCount,
          statusLabel: activityCount === 1 ? t("1 active signal") : activityCount > 1 ? t("{count} active signals", { count: activityCount }) : t("No activity"),
          severity: activityCount > 0 ? "info" : "neutral",
        },
        render: () => activityNode ? (
          <div className="right-dock-activity-stack">
            {activityNode}
          </div>
        ) : (
          <ToolPlaceholderPage
            title={t("No activity yet")}
            description={resolvedActivityDescription}
          />
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
        statusLabel: browserEvidenceCount === 1 ? t("1 browser item") : browserEvidenceCount > 1 ? t("{count} browser items", { count: browserEvidenceCount }) : t("No browser evidence"),
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
        statusLabel: hasTerminalSession ? t("Terminal session") : terminalEvidenceCount === 1 ? t("1 terminal item") : terminalEvidenceCount > 1 ? t("{count} terminal items", { count: terminalEvidenceCount }) : t("No terminal evidence"),
        severity: hasTerminalSession || terminalEvidenceCount > 0 ? "info" : "neutral",
      },
      render: () => terminalSession ? (
        <WorkspaceTerminalPanel
          cwd={cwd}
          className="channel-side-terminal"
          session={terminalSession}
        />
      ) : (
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
    activityDescription,
    activityNode,
    browserEvidenceCount,
    browserGroups,
    contextCount,
    contextDescription,
    contextLabel,
    contextNode,
    detailNodeById,
    evidenceGroups,
    fileItems,
    hasTerminalSession,
    hasContextPage,
    includeActivity,
    includePlans,
    codeChangeActionCount,
    codeChangeReviewItems,
    effectiveReviewCwd,
    currentPlanThreadId,
    onOpenPlanSource,
    planActionBusyId,
    planScope,
    planStatusFilter,
    proposedPlans,
    proposedPlansError,
    externalError,
    proposedPlansLoading,
    surface,
    t,
    terminalEvidenceCount,
    terminalGroups,
    terminalSession,
    cwd,
    visiblePlanCount,
    requestedWorkspaceReview?.path,
    requestedWorkspaceReview?.scope,
    scopedReview,
    scopedResource.status,
    scopedResource.refresh,
    reviewFileCount,
    workspaceChanges,
    workspaceChangesError,
    workspaceChangesLoading,
  ]);

  useEffect(() => {
    if (!open || forcedDetail || !pageRequest) {
      return;
    }
    if (pageRequest.workspaceFile) {
      const sourceId = workspaceFileDetailSourceId(pageRequest.nonce);
      setRequestedWorkspaceFile({ nonce: pageRequest.nonce, target: pageRequest.workspaceFile });
      setStack([
        createDockPageEntry({
          page: "detail",
          title: pageRequest.workspaceFile.label || fileNameFromPath(pageRequest.workspaceFile.path) || pageRequest.workspaceFile.path,
          subtitle: workspaceFileTargetSubtitle(pageRequest.workspaceFile),
          sourceId,
        }),
      ]);
      onPageRequestConsumed?.(pageRequest.nonce);
      return;
    }
    if (pageRequest.page === "review" && pageRequest.workspaceReview) {
      setRequestedWorkspaceReview(pageRequest.workspaceReview);
      setStack([
        createDockPageEntry({
          page: "review",
          title: t("Review workbench"),
          subtitle: pageRequest.workspaceReview.path || t("Workspace changes"),
        }),
      ]);
      onPageRequestConsumed?.(pageRequest.nonce);
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
    if (pageRequest.page === "review") {
      setRequestedWorkspaceReview(undefined);
    }
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
      onNavigate={(entry) => {
        if (entry.page === "review") {
          setRequestedWorkspaceReview(undefined);
        }
        pushPage(entry);
      }}
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
