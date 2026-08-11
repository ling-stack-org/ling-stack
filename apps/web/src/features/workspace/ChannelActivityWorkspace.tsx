import type { ReactNode } from "react";
import { useI18n } from "../../i18n.js";
import { ActivityDrilldownDrawer } from "./ChannelActivityPanels.js";
import { ChannelActivityToolsPanel } from "./ChannelActivityToolsPanel.js";
import { ChannelMessageFeed } from "./ChannelMessageFeed.js";
import { ChannelWorkThreadTree } from "./ChannelWorkThreadTree.js";
import { ThreadReplyPanel } from "./ThreadReplyPanel.js";

type ChannelActivityToolsPanelProps = Parameters<typeof ChannelActivityToolsPanel>[0];
type ChannelWorkThreadTreeProps = Parameters<typeof ChannelWorkThreadTree>[0];
type ChannelMessageFeedProps = Parameters<typeof ChannelMessageFeed>[0];
type ThreadReplyPanelProps = Parameters<typeof ThreadReplyPanel>[0];
type ActivityDrilldownDrawerProps = Parameters<typeof ActivityDrilldownDrawer>[0];

interface ChannelActivityWorkspaceProps {
  readonly activityTools?: ChannelActivityToolsPanelProps;
  readonly workThreadTree?: ChannelWorkThreadTreeProps;
  readonly messageFeed: ChannelMessageFeedProps;
  readonly conversationBlockActionMenuNode?: ReactNode;
  readonly conversationDetailOverlayNode?: ReactNode;
  readonly composerNode: ReactNode;
  readonly threadReply?: ThreadReplyPanelProps;
  readonly drilldown?: ActivityDrilldownDrawerProps;
}

export function ChannelActivityWorkspace({
  activityTools,
  workThreadTree,
  messageFeed,
  conversationBlockActionMenuNode,
  conversationDetailOverlayNode,
  composerNode,
  threadReply,
  drilldown,
}: ChannelActivityWorkspaceProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section className="panel task-list-panel activity-tab-panel channel-chat-panel" aria-label={t("Channel activity")}>
      <div className="activity-shell">
        <div className={threadReply ? "activity-chat-layout with-thread" : "activity-chat-layout"}>
          <div className="activity-chat-main">
            {activityTools ? <ChannelActivityToolsPanel {...activityTools} /> : null}
            {workThreadTree ? <ChannelWorkThreadTree {...workThreadTree} /> : null}
            <ChannelMessageFeed {...messageFeed} />
            {conversationBlockActionMenuNode}
            {conversationDetailOverlayNode}
            {composerNode}
          </div>
          {threadReply ? <ThreadReplyPanel {...threadReply} /> : null}
        </div>
        {drilldown ? <ActivityDrilldownDrawer {...drilldown} /> : null}
      </div>
    </section>
  );
}
