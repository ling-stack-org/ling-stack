import { type KeyboardEvent, type MouseEvent } from "react";
import { Archive, Trash2 } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import type { SkillRegistryEntry } from "../../types.js";
import { SkillStatePill } from "./SkillLibraryWidgets.js";
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
  saving,
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
  readonly saving: boolean;
  readonly selectedSkillId: string | undefined;
  readonly bindingSummaries: readonly TeammateSkillBindingSummary[];
  readonly onSelectSkill: (skillId: string) => void;
  readonly onArchiveSkill: (skillId: string) => void;
  readonly onDeleteSkill: (skill: SkillRegistryEntry) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  function selectRow(skillId: string): void {
    onSelectSkill(skillId);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, skillId: string): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectRow(skillId);
    }
  }

  function stopRowSelection(event: MouseEvent<HTMLElement>): void {
    event.stopPropagation();
  }

  function stopRowKeyboardSelection(event: KeyboardEvent<HTMLElement>): void {
    event.stopPropagation();
  }

  return (
    <div className="settings-skill-table-wrap settings-skill-table-wrap--compact">
      <table className={`settings-skill-table settings-skill-table--compact settings-skill-table--${variant}`}>
        <thead>
          <tr>
            <th>{t("Skill")}</th>
            <th>{t("Description")}</th>
            <th>{t("Bound teammates")}</th>
            <th>{t("Updated")}</th>
            {variant !== "builtin" ? <th aria-label={t("Skill actions")}>{t("Skill actions")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={variant !== "builtin" ? 5 : 4}>
                <div className="compact-empty">{loading ? t("Loading skills...") : t("No skills match these filters")}</div>
              </td>
            </tr>
          ) : entries.map((entry) => {
            const boundTeammates = boundTeammateNames(entry.id, bindingSummaries);
            const state = skillRegistryState(entry, t);
            const selected = selectedSkillId === entry.id;
            const showState = entry.reviewStatus === "draft" || entry.reviewStatus === "disabled";
            const canArchive = variant !== "builtin" && entry.source !== "builtin" && entry.reviewStatus !== "archived";
            const canDelete = canArchive && isManuallyImportedSkill(entry);
            return (
              <tr
                key={entry.id}
                className={selected ? "selected settings-skill-clickable-row" : "settings-skill-clickable-row"}
                tabIndex={0}
                aria-selected={selected}
                onClick={() => selectRow(entry.id)}
                onKeyDown={(event) => handleRowKeyDown(event, entry.id)}
              >
                <td>
                  <span className="settings-skill-name-cell">
                    <strong>{entry.definition.name}</strong>
                    {showState ? <SkillStatePill label={state.label} tone={state.tone} /> : null}
                  </span>
                </td>
                <td className="settings-skill-summary-cell" title={entry.definition.summary || undefined}>
                  {entry.definition.summary || "-"}
                </td>
                <td className="settings-skill-bound-cell">{boundTeammates.length > 0 ? boundTeammates.join(", ") : t("Unbound")}</td>
                <td className="settings-skill-updated-cell">{formatDateTime(entry.updatedAt)}</td>
                {variant !== "builtin" ? (
                  <td className="settings-skill-action-cell">
                    {canArchive ? (
                      <span className="settings-skill-row-actions">
                        <button
                          className="settings-skill-row-action"
                          type="button"
                          aria-label={t("Archive")}
                          title={t("Archive")}
                          disabled={saving}
                          onClick={(event) => {
                            stopRowSelection(event);
                            onArchiveSkill(entry.id);
                          }}
                          onKeyDown={stopRowKeyboardSelection}
                        >
                          <Archive size={15} />
                        </button>
                        {canDelete ? (
                          <button
                            className="settings-skill-row-action danger"
                            type="button"
                            aria-label={t("Delete skill")}
                            title={t("Delete skill")}
                            disabled={saving}
                            onClick={(event) => {
                              stopRowSelection(event);
                              onDeleteSkill(entry);
                            }}
                            onKeyDown={stopRowKeyboardSelection}
                          >
                            <Trash2 size={15} />
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function isManuallyImportedSkill(entry: SkillRegistryEntry): boolean {
  return entry.source === "custom" || entry.source === "skill-directory" || entry.source === "agents-md";
}
