import type { ComponentProps, ReactNode } from "react";
import { ConversationShell } from "../../shared/conversation/index.js";
import { useI18n } from "../../i18n.js";
import { NormalConversationFeed } from "./NormalConversationFeed.js";
import { NormalConversationHeader } from "./NormalConversationHeader.js";
import { NormalConversationWorkspacePanels } from "./NormalConversationWorkspacePanels.js";
import { ConversationSummaryPopover } from "./right-dock/index.js";
import { useConversationSummaryLayout } from "./conversation-summary-layout.js";
import {
  DesktopTitlebarSurface,
  useDesktopTitlebarPlacement,
} from "../../app/DesktopTitlebarSurface.js";

export interface NormalConversationPageProps {
  readonly summaryOpen: boolean;
  readonly onCloseSummary: () => void;
  readonly summaryDockMotion?: string;
  readonly summaryRows: ComponentProps<typeof ConversationSummaryPopover>["rows"];
  readonly headerProps: Omit<ComponentProps<typeof NormalConversationHeader>, "summaryNode" | "summaryExpanded">;
  readonly feedProps: ComponentProps<typeof NormalConversationFeed>;
  readonly composerNode: ReactNode;
  readonly panelsProps: ComponentProps<typeof NormalConversationWorkspacePanels>;
}

export function NormalConversationPage({
  summaryOpen,
  onCloseSummary,
  summaryDockMotion,
  summaryRows,
  headerProps,
  feedProps,
  composerNode,
  panelsProps,
}: NormalConversationPageProps): React.JSX.Element {
  const { t } = useI18n();
  const titlebarPlacement = useDesktopTitlebarPlacement();
  const { dockController, dockViewModel, terminalPresence, terminalResize } = panelsProps;
  const summaryLayout = useConversationSummaryLayout({
    requestedOpen: summaryOpen,
    containerWidth: dockController.containerWidth,
    dockVisible: dockController.visible,
    dockWidth: dockController.width,
  });
  return (
    <ConversationShell
      rootRef={dockController.containerRef}
      style={{
        ...dockController.containerStyle,
        ...terminalResize.panelStyle,
        ...summaryLayout.style,
      }}
      className={[
        "normal-conversation-page",
        `titlebar-${titlebarPlacement}`,
        `right-dock-motion-${dockController.motionState}`,
        dockController.visible ? "with-right-dock" : "",
        summaryLayout.visible ? "with-conversation-summary" : "",
        dockController.visible
          ? summaryLayout.visible ? "summary-panel-expanded" : "summary-panel-collapsed"
          : "",
        dockController.visible && !dockController.expanded ? "workspace-right-dock-collapsed" : "",
        terminalPresence.rendered ? "with-bottom-terminal" : "",
        dockController.resizing ? "is-resizing-workspace-right-dock" : "",
        terminalResize.resizing ? "is-resizing-workspace-bottom-panel" : "",
      ].filter(Boolean).join(" ")}
      ariaLabel={t("Conversation page")}
      headerNode={(
        <DesktopTitlebarSurface>
          <NormalConversationHeader
            {...headerProps}
            summaryExpanded={summaryLayout.visible}
            summaryNode={(
              <ConversationSummaryPopover
                open={summaryLayout.visible}
                title={t("Environment")}
                subtitle={dockViewModel.context.workspaceLabel}
                rows={summaryRows}
                className="normal-conversation-summary-popover normal-conversation-summary-panel"
                dockOffset={summaryLayout.dockOffset}
                dockMotion={summaryDockMotion}
                motionState={dockController.motionState}
                onClose={onCloseSummary}
              />
            )}
          />
        </DesktopTitlebarSurface>
      )}
      feedNode={<NormalConversationFeed {...feedProps} />}
      composerNode={(
        <div
          className="normal-conversation-composer-stack"
          data-computer-use-obstacle="true"
          data-computer-use-obstacle-kind="composer"
        >
          {composerNode}
        </div>
      )}
      sideNode={<NormalConversationWorkspacePanels {...panelsProps} />}
    />
  );
}
