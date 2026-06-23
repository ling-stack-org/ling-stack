import {
  Bot,
  Box,
  Kanban,
  type LucideIcon,
} from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";

export interface WorkspaceToolCounts {
  readonly readyProviderCount: number;
  readonly visibleTeammateCount: number;
  readonly openWorkItemCount: number;
}

interface WorkspaceToolItem {
  readonly id: "providers" | "teammates" | "work-board";
  readonly title: string;
  readonly description: string;
  readonly chipLabel: string;
  readonly actionLabel: string;
  readonly icon: LucideIcon;
  readonly onOpen: () => void;
}

export function SettingsWorkspaceToolsPanel({
  counts,
  onOpenProviders,
  onOpenTeammates,
  onOpenWorkBoard,
}: {
  readonly counts: WorkspaceToolCounts;
  readonly onOpenProviders: () => void;
  readonly onOpenTeammates: () => void;
  readonly onOpenWorkBoard: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const tools: readonly WorkspaceToolItem[] = [
    {
      id: "providers",
      title: t("Model Workbench"),
      description: t("Configure providers, models, and checks."),
      chipLabel: readyModelCountLabel(counts.readyProviderCount, t),
      actionLabel: t("Open Model Workbench"),
      icon: Box,
      onOpen: onOpenProviders,
    },
    {
      id: "teammates",
      title: t("AI Teammates"),
      description: t("Manage teammate roster, models, and private chats."),
      chipLabel: t("{count} teammates", { count: counts.visibleTeammateCount }),
      actionLabel: t("Open AI Teammates"),
      icon: Bot,
      onOpen: onOpenTeammates,
    },
    {
      id: "work-board",
      title: t("Work Board"),
      description: t("Review actionable work across channels and runs."),
      chipLabel: t("{count} pending work items", { count: counts.openWorkItemCount }),
      actionLabel: t("Open Work Board"),
      icon: Kanban,
      onOpen: onOpenWorkBoard,
    },
  ];

  return (
    <section className="settings-workspace-tools" aria-labelledby="workspace-tools-settings-title">
      <h2 id="workspace-tools-settings-title">{t("Workspace tools")}</h2>
      <div className="settings-tool-row-list">
        {tools.map((tool) => (
          <WorkspaceToolRow key={tool.id} tool={tool} />
        ))}
      </div>
    </section>
  );
}

function WorkspaceToolRow({ tool }: { readonly tool: WorkspaceToolItem }): JSX.Element {
  const Icon = tool.icon;
  return (
    <article className="settings-tool-row">
      <span className="settings-tool-row-icon" aria-hidden="true">
        <Icon size={21} />
      </span>
      <span className="settings-tool-row-copy">
        <span className="settings-tool-row-heading">
          <strong>{tool.title}</strong>
          <small>{tool.chipLabel}</small>
        </span>
        <span>{tool.description}</span>
      </span>
      <button className="secondary-button settings-tool-row-action" type="button" onClick={tool.onOpen}>
        {tool.actionLabel}
      </button>
    </article>
  );
}

function readyModelCountLabel(count: number, t: Translate): string {
  return count === 1
    ? t("{count} available model", { count })
    : t("{count} available models", { count });
}
