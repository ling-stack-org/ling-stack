import type {
  EffectiveTeammateSkill,
  SkillRegistryEntry,
  SkillSourceSnapshot,
  TeammateSkillBinding,
} from "../../types.js";
import type { SkillBindingFilter, TeammateSkillRowModel } from "./teammate-skills-view-models.js";

export interface TeammateSkillsSnapshot {
  readonly bindings: readonly TeammateSkillBinding[];
  readonly effectiveSkills: readonly EffectiveTeammateSkill[];
  readonly registryEntries: readonly SkillRegistryEntry[];
  readonly sourceSnapshots: readonly SkillSourceSnapshot[];
}

export interface TeammateSkillsController {
  readonly detailsOpen: boolean;
  readonly effectiveSkills: readonly EffectiveTeammateSkill[];
  readonly feedback: string;
  readonly filter: SkillBindingFilter;
  readonly mutationBusy: boolean;
  readonly mutationKey: string;
  readonly rows: readonly TeammateSkillRowModel[];
  readonly searchQuery: string;
  readonly selectedRow: TeammateSkillRowModel | undefined;
  readonly visibleRows: readonly TeammateSkillRowModel[];
  readonly applySnapshot: (teammateId: string, requestId: number, snapshot: TeammateSkillsSnapshot) => void;
  readonly beginSnapshotRequest: (teammateId: string) => number;
  readonly clearFilters: () => void;
  readonly closeDetails: () => void;
  readonly openDetails: (skillId: string) => void;
  readonly removeBinding: (skillId: string) => Promise<void>;
  readonly setFilter: (filter: SkillBindingFilter) => void;
  readonly setSearchQuery: (value: string) => void;
  readonly toggleBinding: (skillId: string) => Promise<void>;
}
