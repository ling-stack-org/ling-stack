import { History, PlugZap, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { RunRepairHint, RunRepairTarget } from "../../lib/run-evidence.js";
import { Button, InlineFeedback } from "../ui/index.js";

export function RunRepairHintBanner({
  hint,
  runId,
  compact = false,
  onOpenProviders,
  onOpenApprovals,
  onOpenRun,
  onReload,
}: {
  readonly hint: RunRepairHint;
  readonly runId: string;
  readonly compact?: boolean;
  readonly onOpenProviders: () => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onReload?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const canOpenRun = hint.target === "run" && Boolean(onOpenRun);
  const canReload = hint.target === "run" && !onOpenRun && Boolean(onReload);
  const actionLabel = canReload ? "Reload" : hint.actionLabel;
  const onAction = hint.target === "providers"
    ? onOpenProviders
    : hint.target === "approvals"
      ? () => onOpenApprovals(runId)
      : canOpenRun
        ? () => onOpenRun?.(runId)
        : canReload
          ? onReload
          : undefined;

  return (
    <InlineFeedback
      className={`run-repair-hint ${hint.target}${compact ? " compact" : ""}`}
      title={t(hint.title)}
      tone={hint.target === "run" ? "danger" : "warning"}
    >
      <span className="run-repair-body">
        <span className="run-repair-copy">{t(hint.detail)}</span>
        {onAction ? (
          <Button size="sm" variant="secondary" leadingIcon={runRepairIcon(hint.target)} onClick={onAction}>
            {t(actionLabel)}
          </Button>
        ) : null}
      </span>
    </InlineFeedback>
  );
}

function runRepairIcon(target: RunRepairTarget): React.JSX.Element {
  if (target === "providers") {
    return <PlugZap size={14} />;
  }
  if (target === "approvals") {
    return <ShieldCheck size={14} />;
  }
  return <History size={14} />;
}
