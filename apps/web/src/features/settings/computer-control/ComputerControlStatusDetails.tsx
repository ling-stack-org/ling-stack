import { Badge, DataRow } from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";
import type { ComputerControlStatusRow } from "../../../domains/computer-control/computer-control-view-model.js";

export function ComputerControlStatusDetails({
  rows,
}: {
  readonly rows: readonly ComputerControlStatusRow[];
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="computer-control-readiness-list">
      {rows.map((row) => (
        <DataRow
          key={row.id}
          className="computer-control-readiness-row"
          identity={(
            <span className="computer-control-readiness-copy">
              <strong>{t(row.label)}</strong>
              {row.detail ? <small>{t(detailLabel(row.detail))}</small> : null}
            </span>
          )}
          status={(
            <Badge tone={toneFor(row.value)} variant="subtle">
              {t(valueLabel(row.value))}
            </Badge>
          )}
        />
      ))}
    </div>
  );
}

function toneFor(value: ComputerControlStatusRow["value"]): "success" | "warning" | "danger" | "neutral" {
  return value === "ready" ? "success" : value === "attention" ? "warning" : value === "unavailable" ? "danger" : "neutral";
}

function valueLabel(value: ComputerControlStatusRow["value"]): string {
  if (value === "ready") return "Ready";
  if (value === "attention") return "Needs attention";
  if (value === "unavailable") return "Unavailable";
  return "Unknown";
}

function detailLabel(value: string): string {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
