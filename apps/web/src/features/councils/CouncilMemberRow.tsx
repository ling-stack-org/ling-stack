import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { DataRow, IconButton, StatusIndicator, Switch } from "../../shared/ui/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import type { CouncilMemberRowView } from "./council-members-view-model.js";

export function CouncilMemberRow({
  cwd,
  editable,
  index,
  mutationDisabled,
  mutationKind,
  mutationTargetId,
  onMove,
  onRemove,
  onToggle,
  row,
  total,
}: {
  readonly cwd: string;
  readonly editable: boolean;
  readonly index: number;
  readonly mutationDisabled: boolean;
  readonly mutationKind?: "add" | "move" | "remove" | "toggle";
  readonly mutationTargetId?: string;
  readonly onMove: (teammateId: string, delta: -1 | 1) => void;
  readonly onRemove: (teammateId: string, trigger: HTMLButtonElement) => void;
  readonly onToggle: (teammateId: string) => void;
  readonly row: CouncilMemberRowView;
  readonly total: number;
}): JSX.Element {
  const { t } = useI18n();
  const teammateId = row.member.teammateId;
  const rowBusy = mutationTargetId === teammateId;
  const switchLabel = t("Enable {name} in council", { name: row.displayName });

  return (
    <DataRow
      className={editable ? "council-members-row" : "council-members-row council-members-row-readonly"}
      compact
      identity={(
        <span className="council-members-identity">
          <span className="council-members-avatar" aria-hidden="true">
            <TeammateAvatarView
              compact
              cwd={cwd}
              teammate={row.teammate ?? { displayName: row.displayName }}
            />
          </span>
          <strong title={row.displayName}>{row.displayName}</strong>
        </span>
      )}
      loading={rowBusy}
      role="listitem"
      status={(
        <StatusIndicator
          label={row.readinessLabel}
          title={row.readinessTitle}
          tone={row.readinessTone}
        />
      )}
      summary={(
        <span className="council-members-role" title={row.subtitle || t("Council member")}>
          {row.subtitle || t("Council member")}
        </span>
      )}
      actions={editable ? (
        <span className="council-members-actions">
          <IconButton
            disabled={mutationDisabled || index === 0}
            icon={ArrowUp}
            label={t("Move council member up")}
            loading={rowBusy && mutationKind === "move"}
            onClick={() => onMove(teammateId, -1)}
          />
          <IconButton
            disabled={mutationDisabled || index === total - 1}
            icon={ArrowDown}
            label={t("Move council member down")}
            loading={rowBusy && mutationKind === "move"}
            onClick={() => onMove(teammateId, 1)}
          />
          <span className="council-members-switch" title={switchLabel}>
            <Switch
              aria-label={switchLabel}
              checked={row.member.enabled}
              disabled={mutationDisabled}
              loading={rowBusy && mutationKind === "toggle"}
              onCheckedChange={() => onToggle(teammateId)}
            />
          </span>
          <IconButton
            disabled={mutationDisabled}
            icon={Trash2}
            label={t("Remove council member")}
            loading={rowBusy && mutationKind === "remove"}
            onClick={(event) => onRemove(teammateId, event.currentTarget)}
          />
        </span>
      ) : undefined}
    />
  );
}
