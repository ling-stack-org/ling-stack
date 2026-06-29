import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  FileText,
  Globe2,
  ListChecks,
  Search,
  SquareTerminal,
} from "lucide-react";
import { useI18n } from "../../../i18n.js";
import {
  createDockPageEntry,
  EvidencePage,
  FilesPage,
  popDockPage,
  pushDockPage,
  resetDockStack,
  ReviewQueuePage,
  RightDockShell,
  ToolPlaceholderPage,
  type DockEvidenceGroupView,
  type DockFileItem,
  type DockPageStackEntry,
  type DockReviewFilter,
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

export interface WorkspaceRightDockProps {
  readonly surface: DockSurfaceKind;
  readonly open: boolean;
  readonly collapsed?: boolean;
  readonly ariaLabel: string;
  readonly className?: string;
  readonly launcherTitle: string;
  readonly launcherSubtitle?: string;
  readonly reviewItems: readonly DockReviewItem[];
  readonly evidenceGroups: readonly DockEvidenceGroupView[];
  readonly fileItems: readonly DockFileItem[];
  readonly includeActivity?: boolean;
  readonly activityNode?: ReactNode;
  readonly activityCount?: number;
  readonly actions?: ReactNode;
  readonly forcedDetail?: WorkspaceRightDockForcedDetail;
  readonly onClose?: () => void;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
}

export function WorkspaceRightDock({
  surface,
  open,
  collapsed,
  ariaLabel,
  className,
  launcherTitle,
  launcherSubtitle,
  reviewItems,
  evidenceGroups,
  fileItems,
  includeActivity = false,
  activityNode,
  activityCount = 0,
  actions,
  forcedDetail,
  onClose,
  onCollapsedChange,
}: WorkspaceRightDockProps): JSX.Element | null {
  const { t } = useI18n();
  const [stack, setStack] = useState<readonly DockPageStackEntry[]>([]);
  const [reviewFilter, setReviewFilter] = useState<DockReviewFilter>("all");
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
  const reviewActionCount = reviewItems.filter(reviewNeedsAction).length;
  const detailNodeById = useMemo(() => {
    const map = new Map<string, ReactNode>();
    for (const item of reviewItems) {
      map.set(`review:${item.id}`, (
        <DockReviewItemDetail
          item={item}
          labels={{
            status: t("Status"),
            source: t("Source"),
            reason: t("Reason"),
            time: t("Time"),
          }}
        />
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
    if (forcedDetail) {
      map.set(forcedDetail.id, forcedDetail.node);
    }
    return map;
  }, [evidenceGroups, fileItems, forcedDetail, reviewItems, t]);
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
      label: t("Review"),
      icon: <ListChecks size={16} />,
      launcherItem: {
        description: t("Approvals, risk, runtime and blocked work"),
        count: reviewActionCount,
        statusLabel: reviewActionCount > 0 ? t("{count} need review", { count: reviewActionCount }) : t("Clean"),
        severity: reviewActionCount > 0 ? "warning" : "neutral",
      },
      render: () => (
        <ReviewQueuePage
          items={reviewItems}
          activeFilter={reviewFilter}
          filters={[
            { id: "all", label: t("All") },
            { id: "needs_action", label: t("Needs action") },
            { id: "risk", label: t("Risk") },
            { id: "runtime", label: t("Runtime") },
            { id: "files", label: t("Files") },
          ]}
          emptyTitle={t("No review items")}
          emptyDescription={t("Approvals, failed runs, and blocked messages will appear here.")}
          needsActionLabel={t("Needs action")}
          trackedLabel={t("Tracked")}
          onFilterChange={setReviewFilter}
          onOpenItem={(item) => pushDetail(`review:${item.id}`, item.title, item.sourceLabel)}
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
    reviewActionCount,
    reviewFilter,
    reviewItems,
    t,
    terminalEvidenceCount,
    terminalGroups,
  ]);

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

function DockReviewItemDetail({
  item,
  labels,
}: {
  readonly item: DockReviewItem;
  readonly labels: {
    readonly status: string;
    readonly source: string;
    readonly reason: string;
    readonly time: string;
  };
}): JSX.Element {
  return (
    <dl className="right-dock-detail-list">
      <div>
        <dt>{labels.status}</dt>
        <dd>{item.status}</dd>
      </div>
      <div>
        <dt>{labels.source}</dt>
        <dd>{item.sourceLabel ?? item.group}</dd>
      </div>
      <div>
        <dt>{labels.reason}</dt>
        <dd>{item.reason}</dd>
      </div>
      {item.timestampLabel ? (
        <div>
          <dt>{labels.time}</dt>
          <dd>{item.timestampLabel}</dd>
        </div>
      ) : null}
    </dl>
  );
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
