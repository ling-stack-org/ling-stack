import { FileWarning } from "lucide-react";
import type {
  ConversationTimelineDiagnosticItem,
  ConversationTimelineRuntimeDiagnostic,
} from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail, detailExists } from "./timeline-renderer-details.js";

export function ConversationTimelineDiagnosticRenderer({
  item,
  cwd,
  depth,
}: {
  readonly item: ConversationTimelineDiagnosticItem;
  readonly cwd?: string;
  readonly depth: 0 | 1;
}): React.JSX.Element {
  const { t } = useI18n();
  const executionLoop = item.runtimeDiagnostic?.code === "execution_loop_detected"
    ? item.runtimeDiagnostic
    : undefined;

  return (
    <TimelineFactRow
      item={item}
      depth={depth}
      title={executionLoop ? t("Repeated execution stopped") : item.title}
      meta={executionLoop ? t("No new evidence") : item.code}
      icon={<FileWarning size={14} aria-hidden="true" />}
      detail={executionLoop
        ? <ExecutionLoopDiagnosticDetail diagnostic={executionLoop} />
        : detailExists(item) ? <TextDetail text={item.description ?? item.summary} cwd={cwd} /> : undefined}
    />
  );
}

function ExecutionLoopDiagnosticDetail({
  diagnostic,
}: {
  readonly diagnostic: ConversationTimelineRuntimeDiagnostic;
}): React.JSX.Element {
  const { t } = useI18n();
  const pattern = diagnostic.loopKind === "exact_repeat"
    ? t("Same action and result repeated")
    : diagnostic.loopKind === "repeated_update"
      ? t("Same tool update repeated")
      : diagnostic.loopKind === "cycle"
        ? t("Short action cycle repeated")
        : t("Action budget exhausted");

  return (
    <div className="conversation-timeline-diagnostic-detail">
      <p>{t("The run was stopped because repeated activity produced no new evidence.")}</p>
      <dl aria-label={t("Technical details")}>
        <DiagnosticValue label={t("Pattern")} value={pattern} />
        <DiagnosticValue label={t("Occurrences")} value={String(diagnostic.repeatedCount)} />
        <DiagnosticValue label={t("Actions without new evidence")} value={String(diagnostic.noProgressActionCount)} />
        {diagnostic.cycleLength === undefined
          ? null
          : <DiagnosticValue label={t("Cycle length")} value={String(diagnostic.cycleLength)} />}
      </dl>
      <small>{t("Change the instruction or environment before retrying.")}</small>
    </div>
  );
}

function DiagnosticValue({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
