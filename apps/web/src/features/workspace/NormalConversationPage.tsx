import type { ComponentProps, ReactNode } from "react";
import { ConversationShell } from "../../shared/conversation/index.js";
import { useI18n } from "../../i18n.js";
import { NormalConversationFeed } from "./NormalConversationFeed.js";
import { NormalConversationHeader } from "./NormalConversationHeader.js";
import { NormalConversationWorkspacePanels } from "./NormalConversationWorkspacePanels.js";
import { ConversationSummaryPopover } from "./right-dock/index.js";

export interface NormalConversationPageProps {
  readonly summaryOpen: boolean;
  readonly onCloseSummary: () => void;
  readonly summaryDockMotion?: string;
  readonly summaryRows: ComponentProps<typeof ConversationSummaryPopover>["rows"];
  readonly headerProps: Omit<ComponentProps<typeof NormalConversationHeader>, "summaryNode">;
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
  const { dockController, dockViewModel, terminalPresence, terminalResize } = panelsProps;
  return (
    <ConversationShell
      rootRef={dockController.containerRef}
      style={{
        ...dockController.containerStyle,
        ...terminalResize.panelStyle,
      }}
      className={[
        "normal-conversation-page",
        `right-dock-motion-${dockController.motionState}`,
        dockController.visible ? "with-right-dock" : "",
        dockController.visible
          ? summaryOpen ? "summary-panel-expanded" : "summary-panel-collapsed"
          : "",
        dockController.visible && !dockController.expanded ? "workspace-right-dock-collapsed" : "",
        terminalPresence.rendered ? "with-bottom-terminal" : "",
        dockController.resizing ? "is-resizing-workspace-right-dock" : "",
        terminalResize.resizing ? "is-resizing-workspace-bottom-panel" : "",
      ].filter(Boolean).join(" ")}
      ariaLabel={t("Conversation page")}
      headerNode={(
        <NormalConversationHeader
          {...headerProps}
          summaryNode={(
            <ConversationSummaryPopover
              open={summaryOpen}
              title={t("Environment")}
              subtitle={dockViewModel.context.workspaceLabel}
              rows={summaryRows}
              className="normal-conversation-summary-popover normal-conversation-summary-panel"
              dockMotion={summaryDockMotion}
              motionState={dockController.motionState}
              onClose={onCloseSummary}
            />
          )}
        />
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
