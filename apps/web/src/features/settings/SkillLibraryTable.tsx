import { type KeyboardEvent, type MouseEvent } from "react";
import { Archive, Trash2 } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import {
  EmptyState,
  IconButton,
  StatusIndicator,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../shared/ui/index.js";
import type { SkillRegistryEntry } from "../../types.js";
import {
  boundTeammateNames,
  skillRegistryState,
  type SettingsTranslator,
  type TeammateSkillBindingSummary,
} from "./skill-library-utils.js";

export function SkillLibraryTable({
  variant,
  entries,
  loading,
  busyAction,
  selectedSkillId,
  bindingSummaries,
  onSelectSkill,
  onArchiveSkill,
  onDeleteSkill,
  t,
}: {
  readonly variant: "user" | "evolved" | "builtin";
  readonly entries: readonly SkillRegistryEntry[];
  readonly loading: boolean;
  readonly busyAction: string;
  readonly selectedSkillId: string | undefined;
  readonly bindingSummaries: readonly TeammateSkillBindingSummary[];
  readonly onSelectSkill: (skillId: string) => void;
  readonly onArchiveSkill: (skillId: string) => void;
  readonly onDeleteSkill: (skill: SkillRegistryEntry, trigger: HTMLButtonElement) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, skillId: string): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectSkill(skillId);
    }
  }

  function stopRowSelection(event: MouseEvent<HTMLElement>): void {
    event.stopPropagation();
  }

  return (
    <TableContainer className="settings-skill-table-wrap settings-skill-table-wrap--compact">
      <Table className={`settings-skill-table settings-skill-table--compact settings-skill-table--${variant}`}>
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t("Skill")}</TableHeaderCell>
            <TableHeaderCell>{t("Description")}</TableHeaderCell>
            <TableHeaderCell>{t("Bound teammates")}</TableHeaderCell>
            <TableHeaderCell>{t("Updated")}</TableHeaderCell>
            {variant !== "builtin" ? <TableHeaderCell aria-label={t("Skill actions")}>{t("Skill actions")}</TableHeaderCell> : null}
          </TableRow>
        </TableHead>
        <TableBody>
          {entries.length === 0 ? (
            <TableRow>
              <TableCell colSpan={variant !== "builtin" ? 5 : 4}>
                <EmptyState compact title={loading ? t("Loading skills...") : t("No skills match these filters")} />
              </TableCell>
            </TableRow>
          ) : entries.map((entry) => {
            const boundTeammates = boundTeammateNames(entry.id, bindingSummaries);
            const state = skillRegistryState(entry, t);
            const selected = selectedSkillId === entry.id;
            const showState = entry.reviewStatus === "draft" || entry.reviewStatus === "disabled";
            const canArchive = variant !== "builtin" && entry.source !== "builtin" && entry.reviewStatus !== "archived";
            const canDelete = canArchive && isManuallyImportedSkill(entry);
            const archiveBusy = busyAction === `archive:${entry.id}`;
            return (
              <TableRow
                key={entry.id}
                className={selected ? "selected settings-skill-clickable-row" : "settings-skill-clickable-row"}
                data-skill-id={entry.id}
                tabIndex={0}
                aria-selected={selected}
                onClick={() => onSelectSkill(entry.id)}
                onKeyDown={(event) => handleRowKeyDown(event, entry.id)}
              >
                <TableCell>
                  <span className="settings-skill-name-cell">
                    <strong>{entry.definition.name}</strong>
                    {showState ? (
                      <StatusIndicator compact label={state.label} tone={state.tone === "blocked" ? "danger" : "warning"} />
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="settings-skill-summary-cell" title={entry.definition.summary || undefined}>
                  {entry.definition.summary || "-"}
                </TableCell>
                <TableCell className="settings-skill-bound-cell">{boundTeammates.length > 0 ? boundTeammates.join(", ") : t("Unbound")}</TableCell>
                <TableCell className="settings-skill-updated-cell">{formatDateTime(entry.updatedAt)}</TableCell>
                {variant !== "builtin" ? (
                  <TableCell className="settings-skill-action-cell">
                    {canArchive ? (
                      <span className="settings-skill-row-actions" onClick={stopRowSelection}>
                        <IconButton
                          icon={Archive}
                          label={t("Archive")}
                          size="sm"
                          loading={archiveBusy}
                          loadingLabel={t("Archiving...")}
                          disabled={Boolean(busyAction) && !archiveBusy}
                          onClick={() => onArchiveSkill(entry.id)}
                        />
                        {canDelete ? (
                          <IconButton
                            icon={Trash2}
                            label={t("Delete skill")}
                            size="sm"
                            variant="danger"
                            disabled={Boolean(busyAction)}
                            onClick={(event) => onDeleteSkill(entry, event.currentTarget)}
                          />
                        ) : null}
                      </span>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function isManuallyImportedSkill(entry: SkillRegistryEntry): boolean {
  return entry.source === "custom" || entry.source === "skill-directory" || entry.source === "agents-md";
}
