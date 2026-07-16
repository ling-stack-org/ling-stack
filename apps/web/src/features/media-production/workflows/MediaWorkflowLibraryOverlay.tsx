import { useEffect } from "react";
import { Link2, Workflow, X } from "lucide-react";
import type { MediaJob, RunArtifact } from "../../../types.js";
import type {
  MediaWorkflowControllerActions,
  MediaWorkflowControllerState,
  MediaWorkflowLibraryTab,
} from "./media-workflow-types.js";
import { WorkflowConnectionWorkspace } from "./WorkflowConnectionWorkspace.js";
import { WorkflowLibraryWorkspace } from "./WorkflowLibraryWorkspace.js";

export function MediaWorkflowLibraryOverlay({
  open,
  tab,
  state,
  actions,
  mediaJobs,
  imageArtifacts,
  onTabChange,
  onClose,
}: {
  readonly open: boolean;
  readonly tab: MediaWorkflowLibraryTab;
  readonly state: MediaWorkflowControllerState;
  readonly actions: MediaWorkflowControllerActions;
  readonly mediaJobs: readonly MediaJob[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly onTabChange: (tab: MediaWorkflowLibraryTab) => void;
  readonly onClose: () => void;
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="media-workflow-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`media-workflow-dialog ${tab === "connections" ? "connections-view" : "workflows-view"}`} role="dialog" aria-modal="true" aria-label="生产流程库">
        <header className="media-workflow-dialog-head">
          <div>
            <span className="media-workflow-eyebrow">媒体生产</span>
            <h2>生产流程</h2>
            <p>管理 ComfyUI 连接和经过真实试运行的场景流程。</p>
          </div>
          <button className="icon-button" type="button" title="关闭生产流程" aria-label="关闭生产流程" onClick={onClose}><X size={17} /></button>
        </header>
        <nav className="media-workflow-tabs" aria-label="生产流程页内导航">
          <button className={tab === "workflows" ? "selected" : ""} type="button" onClick={() => onTabChange("workflows")}><Workflow size={15} /> 流程</button>
          <button className={tab === "connections" ? "selected" : ""} type="button" onClick={() => onTabChange("connections")}><Link2 size={15} /> 连接</button>
        </nav>
        {state.errorMessage ? <div className="inline-error media-workflow-error">{state.errorMessage}</div> : null}
        <div className="media-workflow-dialog-body">
          {tab === "workflows" ? (
            <WorkflowLibraryWorkspace
              state={state}
              actions={actions}
              mediaJobs={mediaJobs}
              imageArtifacts={imageArtifacts}
              onOpenConnections={() => onTabChange("connections")}
            />
          ) : <WorkflowConnectionWorkspace state={state} actions={actions} />}
        </div>
      </section>
    </div>
  );
}
