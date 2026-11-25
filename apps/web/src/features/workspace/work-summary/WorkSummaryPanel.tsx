import { useEffect, useRef, type ReactNode } from "react";
import { GitBranch } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../shared/ui/index.js";
import { WorkSummaryChangeRow } from "./WorkSummaryChangeRow.js";
import { WorkSummaryProjectOverview } from "./WorkSummaryProjectOverview.js";
import { findCurrentSummaryWorkspace } from "./work-summary-model.js";
import type { WorkSummaryTarget } from "./work-summary.types.js";
import { useWorkSummary } from "./useWorkSummary.js";
import { useWorkSummaryContext } from "./WorkSummaryProvider.js";

interface WorkSummaryPanelProps {
  readonly visible: boolean;
  readonly currentTarget?: WorkSummaryTarget;
  readonly showCurrentBranch?: boolean;
  readonly onClose: () => void;
  readonly onOpenChanges?: (cwd: string) => void;
  readonly children: ReactNode;
}

export function WorkSummaryPanel(props: WorkSummaryPanelProps): ReactNode {
  const context = useWorkSummaryContext();
  return context?.cwd.trim()
    ? <ProjectWorkSummary key={context.cwd} {...props} context={context} />
    : props.children;
}

function ProjectWorkSummary({
  visible,
  currentTarget,
  showCurrentBranch = true,
  onClose,
  onOpenChanges,
  children,
  context,
}: WorkSummaryPanelProps & { readonly context: NonNullable<ReturnType<typeof useWorkSummaryContext>> }): React.JSX.Element {
  const { cwd, rememberTrigger, restoreFocus } = context;
  const { t } = useI18n();
  const summary = useWorkSummary(cwd, visible);
  const currentWorkspace = findCurrentSummaryWorkspace(summary.data, currentTarget);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!visible) return;
    rememberTrigger();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
      restoreFocus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [visible, rememberTrigger, restoreFocus]);

  function openChanges(path: string): void {
    onOpenChanges?.(path);
    onClose();
  }

  return (
    <section className="work-summary-panel" aria-label={t("Work summary")}>
      <Tabs defaultValue="conversation">
        <TabsList aria-label={t("Work summary")} className="work-summary-tabs" appearance="contained" size="sm">
          <TabsTrigger value="conversation">{t("Current conversation")}</TabsTrigger>
          <TabsTrigger value="project">{t("Project overview")}</TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="work-summary-view">
          {children}
          {currentWorkspace ? (
            <div className="work-summary-current-workspace">
              {showCurrentBranch && currentWorkspace.branch ? (
                <div className="work-summary-current-branch" title={currentWorkspace.cwd}>
                  <GitBranch size={15} aria-hidden="true" />
                  <span>{currentWorkspace.branch}</span>
                </div>
              ) : null}
              <WorkSummaryChangeRow workspace={currentWorkspace} onOpen={onOpenChanges ? () => openChanges(currentWorkspace.cwd) : undefined} />
              {currentWorkspace.error ? <small role="status" className="work-summary-note">{t("Workspace read failed; last available snapshot shown")}</small> : null}
            </div>
          ) : currentTarget && summary.error ? (
            <p role="status" className="work-summary-note">{t("Unable to load workspace changes")}</p>
          ) : null}
        </TabsContent>
        <TabsContent value="project" className="work-summary-view" forceMount>
          <WorkSummaryProjectOverview
            cwd={cwd}
            data={summary.data}
            error={summary.error}
            loading={summary.loading}
            currentWorkspaceKey={currentWorkspace?.key}
            onRefresh={summary.refresh}
            onOpenChanges={onOpenChanges ? openChanges : undefined}
            onOpenSession={(session) => { onClose(); context.onOpenSession(session); }}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
