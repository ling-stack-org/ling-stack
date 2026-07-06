import { Archive, Eye } from "lucide-react";
import type {
  SkillRegistryEntry,
  SkillSourceSnapshot,
} from "../../types.js";
import { workflowPhaseLabel } from "../teammates/helpers.js";
import {
  SkillSourceStatus,
  SkillStatePill,
} from "./SkillLibraryWidgets.js";
import {
  boundTeammateNames,
  skillRegistryState,
  type SettingsTranslator,
  type TeammateSkillBindingSummary,
} from "./skill-library-utils.js";

export function SkillLibraryTable({
  entries,
  loading,
  saving,
  selectedSkillId,
  bindingSummaries,
  sourceSnapshotBySkillId,
  onSelectSkill,
  onArchiveSkill,
  t,
}: {
  readonly entries: readonly SkillRegistryEntry[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly selectedSkillId: string | undefined;
  readonly bindingSummaries: readonly TeammateSkillBindingSummary[];
  readonly sourceSnapshotBySkillId: ReadonlyMap<string, SkillSourceSnapshot>;
  readonly onSelectSkill: (skillId: string) => void;
  readonly onArchiveSkill: (skillId: string) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  return (
    <div className="settings-skill-table-wrap settings-skill-table-wrap--compact">
      <table className="settings-skill-table settings-skill-table--compact">
        <thead>
          <tr>
            <th>{t("Status")}</th>
            <th>{t("Skill")}</th>
            <th>{t("Source")}</th>
            <th>{t("Stage")}</th>
            <th>{t("Bound teammates")}</th>
            <th>{t("Actions")}</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <div className="compact-empty">{loading ? t("Loading skills...") : t("No skills match these filters")}</div>
              </td>
            </tr>
          ) : entries.map((entry) => {
            const boundTeammates = boundTeammateNames(entry.id, bindingSummaries);
            const state = skillRegistryState(entry, t);
            const selected = selectedSkillId === entry.id;
            const canArchive = entry.source !== "builtin" && entry.reviewStatus !== "archived";
            const sourceSnapshot = sourceSnapshotBySkillId.get(entry.id);
            return (
              <tr key={entry.id} className={selected ? "selected" : ""}>
                <td><SkillStatePill label={state.label} tone={state.tone} /></td>
                <td>
                  <button className="settings-skill-name-button" type="button" onClick={() => onSelectSkill(entry.id)}>
                    <strong>{entry.definition.name}</strong>
                  </button>
                </td>
                <td><SkillSourceStatus source={entry.source} snapshot={sourceSnapshot} showState={false} t={t} /></td>
                <td><span className={`phase-token ${entry.definition.workflowPhase}`}>{workflowPhaseLabel(entry.definition.workflowPhase, t)}</span></td>
                <td>{boundTeammates.length > 0 ? boundTeammates.join(", ") : t("Unbound")}</td>
                <td>
                  <span className="settings-skill-row-actions">
                    <button className="secondary-button compact-button" type="button" onClick={() => onSelectSkill(entry.id)}>
                      <Eye size={14} />
                      {t("Details")}
                    </button>
                    {canArchive ? (
                      <button className="secondary-button danger compact-button" type="button" onClick={() => onArchiveSkill(entry.id)} disabled={saving}>
                        <Archive size={14} />
                        {t("Archive")}
                      </button>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
