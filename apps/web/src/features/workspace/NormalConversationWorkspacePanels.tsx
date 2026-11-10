import type { ProposedPlanArtifact } from "../../types.js";
import { useI18n } from "../../i18n.js";
import type { WorkspaceBottomPanelResizeController } from "./useWorkspaceBottomPanelResizeController.js";
import type { WorkspaceRightDockController } from "./useWorkspaceRightDockController.js";
import type { ConversationPanelPresence } from "./useConversationPanelPresence.js";
import {
  WorkspaceRightDock,
} from "./right-dock/index.js";
import {
  WorkspaceTerminalPanel,
  type WorkspaceTerminalSession,
} from "./WorkspaceTerminalPanel.js";
import {
  NormalConversationActivityPage,
  NormalConversationContextPage,
} from "./NormalConversationDockPages.js";
import type { NormalConversationDockViewModel } from "./normal-conversation-dock-projections.js";

export interface NormalConversationWorkspacePanelsProps {
  readonly workspaceCwd: string;
  readonly currentThreadId?: string;
  readonly dockController: WorkspaceRightDockController;
  readonly dockViewModel: NormalConversationDockViewModel;
  readonly proposedPlans: readonly ProposedPlanArtifact[];
  readonly proposedPlansLoading: boolean;
  readonly proposedPlansError: string;
  readonly terminalPresence: ConversationPanelPresence;
  readonly terminalResize: WorkspaceBottomPanelResizeController;
  readonly terminalSession: WorkspaceTerminalSession;
  readonly onCloseDock: () => void;
  readonly onCloseTerminal: () => void;
}

export function NormalConversationWorkspacePanels({
  workspaceCwd,
  currentThreadId,
  dockController,
  dockViewModel,
  proposedPlans,
  proposedPlansLoading,
  proposedPlansError,
  terminalPresence,
  terminalResize,
  terminalSession,
  onCloseDock,
  onCloseTerminal,
}: NormalConversationWorkspacePanelsProps): React.JSX.Element {
  const { t } = useI18n();
  const effectiveCwd = workspaceCwd.trim();
  return (
    <>
      {dockController.resizable ? (
        <button
          className="workspace-right-dock-resize-handle"
          type="button"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Resize workspace dock")}
          title={t("Drag to resize workspace dock")}
          tabIndex={dockController.expanded ? 0 : -1}
          onPointerDown={dockController.handleResizePointerDown}
          onPointerMove={dockController.handleResizePointerMove}
          onPointerUp={dockController.handleResizePointerEnd}
          onPointerCancel={dockController.handleResizePointerEnd}
          onLostPointerCapture={dockController.handleResizePointerEnd}
        />
      ) : null}
      {dockController.visible ? (
        <div
          className="workspace-right-dock-frame normal-conversation-right-dock-frame"
          data-computer-use-obstacle="true"
          data-computer-use-obstacle-kind="right-dock"
          aria-hidden={dockController.expanded ? undefined : true}
        >
          <WorkspaceRightDock
            surface="normal_conversation"
            open={dockController.visible}
            ariaLabel={t("Conversation workspace dock")}
            className={[
              "normal-conversation-right-dock",
              dockController.expanded ? "is-drawer-expanded" : "is-drawer-collapsed",
            ].join(" ")}
            cwd={effectiveCwd}
            launcherTitle={t("Workspace tools")}
            launcherSubtitle={dockViewModel.context.workspaceLabel}
            reviewItems={dockViewModel.reviewItems}
            evidenceGroups={dockViewModel.evidenceGroups}
            fileItems={dockViewModel.fileItems}
            terminalSession={effectiveCwd ? terminalSession : undefined}
            proposedPlans={proposedPlans}
            proposedPlansLoading={proposedPlansLoading}
            proposedPlansError={proposedPlansError}
            currentPlanThreadId={currentThreadId}
            contextNode={<NormalConversationContextPage context={dockViewModel.context} />}
            contextLabel={t("Context")}
            contextDescription={t("Conversation context and workspace state")}
            contextCount={5}
            includeActivity
            activityNode={<NormalConversationActivityPage items={dockViewModel.activityItems} />}
            activityCount={dockViewModel.activityCount}
            pageRequest={dockController.pageRequest}
            onPageRequestConsumed={dockController.consumePageRequest}
            onClose={onCloseDock}
          />
        </div>
      ) : null}
      {terminalPresence.rendered ? (
        <WorkspaceTerminalPanel
          cwd={effectiveCwd}
          className="workspace-bottom-terminal normal-conversation-bottom-terminal"
          session={terminalSession}
          style={terminalResize.panelStyle}
          expanded={terminalPresence.expanded}
          motionState={terminalPresence.motionState}
          resizing={terminalResize.resizing}
          resizeHandleNode={(
            <button
              className="workspace-bottom-panel-resize-handle"
              type="button"
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("Resize terminal panel")}
              title={t("Drag to resize terminal panel")}
              onPointerDown={terminalResize.handleResizePointerDown}
              onPointerMove={terminalResize.handleResizePointerMove}
              onPointerUp={terminalResize.handleResizePointerEnd}
              onPointerCancel={terminalResize.handleResizePointerEnd}
              onLostPointerCapture={terminalResize.handleResizePointerEnd}
            />
          )}
          onClose={onCloseTerminal}
        />
      ) : null}
    </>
  );
}
