import { History, PlugZap, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { RunRepairHint, RunRepairTarget } from "../../lib/run-evidence.js";

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
}): JSX.Element {
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
    <div className={`run-repair-hint ${hint.target}${compact ? " compact" : ""}`}>
      <span className="run-repair-icon">{runRepairIcon(hint.target)}</span>
      <span className="run-repair-copy">
        <strong>{t(hint.title)}</strong>
        <small>{t(hint.detail)}</small>
      </span>
      {onAction ? (
        <button className="secondary-button compact-button" type="button" onClick={onAction}>
          {runRepairIcon(hint.target)}
          {t(actionLabel)}
        </button>
      ) : null}
    </div>
  );
}

function runRepairIcon(target: RunRepairTarget): JSX.Element {
  if (target === "providers") {
    return <PlugZap size={14} />;
  }
  if (target === "approvals") {
    return <ShieldCheck size={14} />;
  }
  return <History size={14} />;
}
