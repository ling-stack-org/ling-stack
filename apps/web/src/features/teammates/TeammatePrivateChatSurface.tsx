import { useI18n } from "../../i18n.js";
import { ConversationShell } from "../../shared/conversation/index.js";
import {
  WorkspaceRightDock,
} from "../workspace/right-dock/index.js";
import { useConversationPanelPresence } from "../workspace/useConversationPanelPresence.js";
import { useWorkspaceBottomPanelResizeController } from "../workspace/useWorkspaceBottomPanelResizeController.js";
import {
  useWorkspaceTerminalSession,
  WorkspaceTerminalPanel,
} from "../workspace/WorkspaceTerminalPanel.js";
import { TeammatePrivateChatComposer } from "./TeammatePrivateChatComposer.js";
import {
  TeammatePrivateChatActivityPage,
  TeammatePrivateChatContextPage,
} from "./TeammatePrivateChatDockPages.js";
import { TeammatePrivateChatFeed } from "./TeammatePrivateChatFeed.js";
import type { TeammatePrivateChatSurfaceProps } from "./teammate-private-chat-types.js";
import { useTeammatePrivateComposerController } from "./useTeammatePrivateComposerController.js";
import { useTeammatePrivateMessageController } from "./useTeammatePrivateMessageController.js";

export function TeammatePrivateChatSurface(props: TeammatePrivateChatSurfaceProps): JSX.Element {
  const { t } = useI18n();
  const {
    cwd,
    dockViewModel,
    dockActions,
    dockController,
    dockOpen,
    dockPageRequest,
    onComposerKeyDown,
    onComposerSubmit,
    onDockClose,
    onDockPageRequestConsumed,
    onMessageDraftChange,
    onRefreshMessages,
    onTerminalClose,
    onWorkspaceAccessModeChange,
    privateComposerSending,
    slashCommands,
    summaryOpen,
    teammate,
    terminalOpen,
    visibleMessages,
    workspaceAccessMode,
  } = props;
  const bottomPanelResize = useWorkspaceBottomPanelResizeController({
    containerRef: dockController.containerRef,
    resizeObserverKey: `${teammate.id}:${cwd.trim()}`,
  });
  const terminalPresence = useConversationPanelPresence(terminalOpen, false);
  const terminalSession = useWorkspaceTerminalSession(cwd.trim());
  const composerController = useTeammatePrivateComposerController({
    identityKey: teammate.id,
    messageDraft: props.messageDraft,
    onComposerKeyDown,
    onComposerSubmit,
    onMessageDraftChange,
    onWorkspaceAccessModeChange,
    privateComposerSending,
    slashCommands,
    workspaceAccessMode,
  });
  const messageController = useTeammatePrivateMessageController({
    cwd,
    messages: visibleMessages,
    onRefreshMessages,
    permissionPreset: composerController.selectedPermissionPreset,
    teammate,
  });
  return (
    <ConversationShell
      rootRef={dockController.containerRef}
      style={{
        ...dockController.containerStyle,
        ...bottomPanelResize.panelStyle,
      }}
      className={[
        "teammate-private-chat",
        `right-dock-motion-${dockController.motionState}`,
        dockController.visible ? "with-right-dock" : "",
        dockController.visible ? (summaryOpen ? "summary-panel-expanded" : "summary-panel-collapsed") : "",
        dockController.visible && !dockController.expanded ? "workspace-right-dock-collapsed" : "",
        terminalPresence.rendered ? "with-bottom-terminal" : "",
        dockController.resizing ? "is-resizing-workspace-right-dock" : "",
        bottomPanelResize.resizing ? "is-resizing-workspace-bottom-panel" : "",
      ].filter(Boolean).join(" ")}
      ariaLabel={t("Private chat")}
      feedNode={<TeammatePrivateChatFeed {...props} messageController={messageController} />}
      composerNode={<TeammatePrivateChatComposer {...props} controller={composerController} />}
      sideNode={(
        <>
          {dockController.visible ? (
            <button
              className="workspace-right-dock-resize-handle"
              type="button"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("Resize workspace dock")}
              title={t("Drag to resize workspace dock")}
              onPointerDown={dockController.handleResizePointerDown}
              onPointerMove={dockController.handleResizePointerMove}
              onPointerUp={dockController.handleResizePointerEnd}
              onPointerCancel={dockController.handleResizePointerEnd}
              onLostPointerCapture={dockController.handleResizePointerEnd}
            />
          ) : null}
          {dockController.visible ? (
            <div
              className="workspace-right-dock-frame teammate-private-right-dock-frame"
              data-computer-use-obstacle="true"
              data-computer-use-obstacle-kind="right-dock"
            >
              <WorkspaceRightDock
                surface="teammate_direct"
                open={dockOpen}
                ariaLabel={t("Private chat workspace dock")}
                className="teammate-private-right-dock"
                cwd={cwd.trim()}
                launcherTitle={t("Workspace tools")}
                launcherSubtitle={teammate.displayName}
                reviewItems={dockViewModel.reviewItems}
                evidenceGroups={dockViewModel.evidenceGroups}
                fileItems={dockViewModel.fileItems}
                terminalSession={terminalSession}
                includePlans={false}
                contextNode={<TeammatePrivateChatContextPage context={dockViewModel.context} cwd={cwd} />}
                contextCount={dockViewModel.contextCount}
                includeActivity
                activityNode={<TeammatePrivateChatActivityPage items={dockViewModel.activityItems} />}
                activityCount={dockViewModel.activityCount}
                activityDescription={t("Teammate activity and private conversation state")}
                actions={dockActions}
                pageRequest={dockPageRequest}
                onPageRequestConsumed={onDockPageRequestConsumed}
                onClose={onDockClose}
              />
            </div>
          ) : null}
          {terminalPresence.rendered ? (
            <WorkspaceTerminalPanel
              cwd={cwd.trim()}
              className="workspace-bottom-terminal teammate-private-bottom-terminal"
              session={terminalSession}
              style={bottomPanelResize.panelStyle}
              expanded={terminalPresence.expanded}
              motionState={terminalPresence.motionState}
              resizing={bottomPanelResize.resizing}
              resizeHandleNode={(
                <button
                  className="workspace-bottom-panel-resize-handle"
                  type="button"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label={t("Resize terminal panel")}
                  title={t("Drag to resize terminal panel")}
                  onPointerDown={bottomPanelResize.handleResizePointerDown}
                  onPointerMove={bottomPanelResize.handleResizePointerMove}
                  onPointerUp={bottomPanelResize.handleResizePointerEnd}
                  onPointerCancel={bottomPanelResize.handleResizePointerEnd}
                  onLostPointerCapture={bottomPanelResize.handleResizePointerEnd}
                />
              )}
              onClose={onTerminalClose}
            />
          ) : null}
        </>
      )}
    />
  );
}
