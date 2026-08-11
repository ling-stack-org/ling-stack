import { ExternalLink } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { WorkItemView } from "../../lib/work-items.js";
import { Button } from "../../shared/ui/index.js";

export function WorkBoardLinkedObjects({ item, onOpenTask, onOpenRun, onOpenApproval, onOpenChannel }: {
  readonly item: WorkItemView;
  readonly onOpenTask: (id: string) => void;
  readonly onOpenRun: (id: string) => void;
  readonly onOpenApproval: (id: string) => void;
  readonly onOpenChannel: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const links = [
    item.taskId ? { key: "task", label: t("Task"), value: item.taskId, open: () => onOpenTask(item.taskId as string) } : undefined,
    item.runId ? { key: "run", label: t("Run"), value: item.runId, open: () => onOpenRun(item.runId as string) } : undefined,
    item.approvalId ? { key: "approval", label: t("Approval"), value: item.approvalId, open: () => onOpenApproval(item.approvalId as string) } : undefined,
    item.channelId ? { key: "channel", label: t("Channel"), value: item.channelId, open: () => onOpenChannel(item.channelId as string) } : undefined,
  ].filter(Boolean) as { readonly key: string; readonly label: string; readonly value: string; readonly open: () => void }[];
  if (links.length === 0) return <p>{t("No linked objects")}</p>;
  return <div className="work-board-linked-list">{links.map((link) => <Button className="work-board-linked-row" key={link.key} leadingIcon={<ExternalLink aria-hidden="true" size={14} />} size="sm" variant="ghost" onClick={link.open}><span>{link.label}</span><strong dir="auto">{link.value}</strong></Button>)}</div>;
}
