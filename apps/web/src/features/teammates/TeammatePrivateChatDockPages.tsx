import type { ReactNode } from "react";
import {
  Activity,
  Bot,
  Brain,
  ExternalLink,
  FileText,
  FolderOpen,
  ListChecks,
  MessageSquare,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { attachmentContentUrlById } from "../../api.js";
import { useI18n } from "../../i18n.js";
import {
  DataRow,
  EmptyState,
  InlineFeedback,
  InspectorSection,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type {
  TeammatePrivateDockActivityView,
  TeammatePrivateDockContextView,
} from "./teammate-private-dock.js";

export function TeammatePrivateChatContextPage({
  context,
  cwd,
}: {
  readonly context: TeammatePrivateDockContextView;
  readonly cwd: string;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section
      className="teammate-private-dock-page teammate-private-context-page"
      aria-label={t("Conversation context")}
    >
      <header className="teammate-private-dock-page-header">
        <strong>{context.teammateName}</strong>
      </header>

      {context.workspace.error ? (
        <InlineFeedback tone="danger" title={t("Private workspace")}>
          {context.workspace.error}
        </InlineFeedback>
      ) : null}

      <div className="teammate-private-dock-list" role="list">
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<FolderOpen />} label={t("Private workspace")} />}
          summary={context.workspace.pathLabel}
          status={<StatusIndicator compact label={context.workspace.statusLabel} tone={context.workspace.tone} />}
        />
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<MessageSquare />} label={t("Latest reply")} />}
          summary={context.latestReply?.summary ?? t("No AI reply summary yet.")}
          status={context.latestReply ? <small>{context.latestReply.timestampLabel}</small> : undefined}
        />
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<FileText />} label={t("Files")} />}
          summary={countLabel(context.fileCount, t("1 file"), t("{count} files", { count: context.fileCount }))}
        />
        {context.memories.length === 0 ? (
          <DataRow
            compact
            role="listitem"
            identity={<DockIdentity icon={<Brain />} label={t("Memory")} />}
            summary={t("No used memory in this private thread yet.")}
          />
        ) : context.memories.map((memory) => (
          <DataRow
            compact
            role="listitem"
            key={memory.id}
            identity={<DockIdentity icon={<Brain />} label={memory.title} />}
            summary={memory.summary}
            status={<StatusIndicator compact label={t("Memory")} tone="info" />}
          />
        ))}
        <DataRow
          compact
          role="listitem"
          identity={<DockIdentity icon={<SquareTerminal />} label={t("Runs")} />}
          summary={countLabel(context.runCount, t("1 run"), t("{count} runs", { count: context.runCount }))}
        />
      </div>

      <InspectorSection
        className="teammate-private-context-section"
        title={t("Private attachments")}
        summary={countLabel(context.attachments.length, t("1 file"), t("{count} files", { count: context.attachments.length }))}
      >
        {context.attachments.length === 0 ? (
          <EmptyState compact icon={<FileText />} title={t("No private attachments yet.")} />
        ) : (
          <div className="teammate-private-dock-list" role="list">
            {context.attachments.map((attachment) => (
              <DataRow
                compact
                role="listitem"
                key={attachment.id}
                identity={<DockIdentity icon={<FileText />} label={attachment.name} />}
                summary={attachment.summary}
                actions={(
                  <a
                    className="teammate-private-dock-link"
                    href={attachmentContentUrlById(attachment.id, cwd.trim())}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={attachment.name}
                    title={attachment.name}
                  >
                    <ExternalLink aria-hidden="true" />
                  </a>
                )}
              />
            ))}
          </div>
        )}
      </InspectorSection>

      <InspectorSection
        className="teammate-private-context-technical"
        title={t("Technical context")}
        summary={context.threadId ? t("Thread details") : t("No saved thread")}
      >
        <dl className="teammate-private-context-details">
          <div><dt>{t("AI teammate")}</dt><dd>{context.teammateRoleLabel}</dd></div>
          <div><dt>{t("Thread")}</dt><dd>{context.threadId ?? t("Not available")}</dd></div>
          <div><dt>{t("Workspace")}</dt><dd>{context.workspace.executionPath ?? t("Not available")}</dd></div>
          <div><dt>{t("Mode")}</dt><dd>{context.workspace.modeLabel ?? t("Not available")}</dd></div>
          <div><dt>{t("Branch")}</dt><dd>{context.workspace.branchName ?? t("Not available")}</dd></div>
          <div><dt>{t("Messages")}</dt><dd>{context.messageCount}</dd></div>
          <div><dt>{t("Execution actions")}</dt><dd>{context.actionCount}</dd></div>
          <div><dt>{t("Terminal reports")}</dt><dd>{context.terminalReportCount}</dd></div>
          <div><dt>{t("Last checked")}</dt><dd>{context.workspace.checkedAtLabel ?? t("Not available")}</dd></div>
        </dl>
      </InspectorSection>
    </section>
  );
}

export function TeammatePrivateChatActivityPage({
  items,
}: {
  readonly items: readonly TeammatePrivateDockActivityView[];
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section
      className="teammate-private-dock-page teammate-private-activity-page"
      aria-label={t("Private conversation activity")}
    >
      {items.length === 0 ? (
        <EmptyState compact icon={<ListChecks />} title={t("No teammate activity yet")} />
      ) : (
        <div className="teammate-private-dock-list" role="list">
          {items.map((item) => (
            <DataRow
              compact
              role="listitem"
              key={item.id}
              identity={<DockIdentity icon={activityIcon(item.kind)} label={item.title} />}
              summary={item.summary}
              status={(
                <span className="teammate-private-activity-status">
                  <StatusIndicator compact label={item.statusLabel} tone={item.tone} />
                  <small>{item.timestampLabel}</small>
                </span>
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DockIdentity({ icon, label }: { readonly icon: ReactNode; readonly label: string }): JSX.Element {
  return (
    <span className="teammate-private-dock-identity">
      <span aria-hidden="true">{icon}</span>
      <strong>{label}</strong>
    </span>
  );
}

function activityIcon(kind: TeammatePrivateDockActivityView["kind"]): ReactNode {
  if (kind === "execution") return <SquareTerminal />;
  if (kind === "run") return <Workflow />;
  if (kind === "approval") return <ListChecks />;
  if (kind === "task") return <Activity />;
  if (kind === "channel-message") return <MessageSquare />;
  if (kind === "direct-message") return <Bot />;
  return <Activity />;
}

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}
