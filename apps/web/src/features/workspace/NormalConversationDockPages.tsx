import type { ReactNode } from "react";
import {
  FileText,
  FolderOpen,
  ListChecks,
  MessageSquare,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  DataRow,
  EmptyState,
  InspectorSection,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type {
  NormalConversationDockActivityItem,
  NormalConversationDockContextView,
} from "./normal-conversation-dock-projections.js";

export interface NormalConversationContextPageProps {
  readonly context: NormalConversationDockContextView;
}

export function NormalConversationContextPage({ context }: NormalConversationContextPageProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section
      className="normal-conversation-dock-page normal-conversation-context-page"
      aria-label={t("Conversation context")}
    >
      <header className="normal-conversation-dock-page-header">
        <strong>{context.conversationTitle}</strong>
      </header>
      <div className="normal-conversation-dock-list" role="list">
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<FolderOpen />} label={t("Workspace")} />}
          summary={context.workspacePath ?? context.workspaceLabel}
          status={<StatusIndicator compact label={context.workspacePath ? t("Available") : t("Unavailable")} tone={context.workspacePath ? "success" : "neutral"} />}
        />
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<MessageSquare />} label={t("Messages")} />}
          summary={countLabel(context.messageCount, t("1 message"), t("{count} messages", { count: context.messageCount }))}
        />
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<Workflow />} label={t("Turns")} />}
          summary={countLabel(context.turnCount, t("1 turn"), t("{count} turns", { count: context.turnCount }))}
        />
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<SquareTerminal />} label={t("Runs")} />}
          summary={context.latestRun?.label ?? t("No runs")}
          status={context.latestRun ? <StatusIndicator compact label={context.latestRun.statusLabel} tone={context.latestRun.tone} /> : undefined}
        />
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<FileText />} label={t("Files")} />}
          summary={countLabel(context.fileCount, t("1 file"), t("{count} files", { count: context.fileCount }))}
        />
      </div>
      <InspectorSection
        className="normal-conversation-context-technical"
        title={t("Technical context")}
        summary={context.threadId ? t("Thread details") : t("No saved thread")}
      >
        <dl className="normal-conversation-context-details">
          <div><dt>{t("Thread")}</dt><dd>{context.threadId ?? t("Not available")}</dd></div>
          <div><dt>{t("Execution actions")}</dt><dd>{context.actionCount}</dd></div>
          <div><dt>{t("Terminal reports")}</dt><dd>{context.terminalReportCount}</dd></div>
        </dl>
      </InspectorSection>
    </section>
  );
}

export interface NormalConversationActivityPageProps {
  readonly items: readonly NormalConversationDockActivityItem[];
}

export function NormalConversationActivityPage({ items }: NormalConversationActivityPageProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section
      className="normal-conversation-dock-page normal-conversation-activity-page"
      aria-label={t("Conversation activity")}
    >
      {items.length === 0 ? (
        <EmptyState compact icon={<ListChecks />} title={t("No activity yet")} />
      ) : (
        <div className="normal-conversation-dock-list" role="list">
          {items.map((item) => (
            <DataRow
              compact
              role="listitem"
              key={item.id}
              identity={(
                <DockIdentity
                  icon={item.kind === "execution" ? <SquareTerminal /> : <MessageSquare />}
                  label={item.title}
                />
              )}
              summary={item.summary}
              status={(
                <span className="normal-conversation-activity-status">
                  <StatusIndicator compact label={item.statusLabel} tone={item.tone} />
                  {item.timestampLabel ? <small>{item.timestampLabel}</small> : null}
                </span>
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DockIdentity({ icon, label }: { readonly icon: ReactNode; readonly label: string }): React.JSX.Element {
  return (
    <span className="normal-conversation-dock-identity">
      <span aria-hidden="true">{icon}</span>
      <strong>{label}</strong>
    </span>
  );
}

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}
