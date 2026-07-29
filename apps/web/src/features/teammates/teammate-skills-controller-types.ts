import type {
  EffectiveTeammateSkill,
  SkillImportDraft,
  SkillPackSource,
  SkillRegistryEntry,
  SkillSourceSnapshot,
  TeammateSkillBinding,
} from "../../types.js";
import type {
  SkillBindingFilter,
  TeammateSkillRowModel,
  TeammateSkillStats,
} from "./teammate-skills-view-models.js";

export interface SkillImportForm {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: SkillPackSource;
  readonly content: string;
}

export interface TeammateSkillsSnapshot {
  readonly bindings: readonly TeammateSkillBinding[];
  readonly effectiveSkills: readonly EffectiveTeammateSkill[];
  readonly registryEntries: readonly SkillRegistryEntry[];
  readonly sourceSnapshots: readonly SkillSourceSnapshot[];
}

export interface TeammateSkillsController {
  readonly archiveConfirmRow: TeammateSkillRowModel | undefined;
  readonly detailsOpen: boolean;
  readonly effectiveSkills: readonly EffectiveTeammateSkill[];
  readonly feedback: string;
  readonly filter: SkillBindingFilter;
  readonly importDraft: SkillImportDraft | undefined;
  readonly importError: string;
  readonly importForm: SkillImportForm;
  readonly importOpen: boolean;
  readonly manualSkillId: string;
  readonly manualSkillIdError: string;
  readonly mutationBusy: boolean;
  readonly mutationKey: string;
  readonly rows: readonly TeammateSkillRowModel[];
  readonly searchQuery: string;
  readonly selectedRow: TeammateSkillRowModel | undefined;
  readonly stats: TeammateSkillStats;
  readonly visibleRows: readonly TeammateSkillRowModel[];
  readonly applySnapshot: (teammateId: string, requestId: number, snapshot: TeammateSkillsSnapshot) => void;
  readonly beginSnapshotRequest: (teammateId: string) => number;
  readonly archiveSkillFromRegistry: () => Promise<void>;
  readonly bindManualSkill: () => Promise<void>;
  readonly clearFilters: () => void;
  readonly closeDetails: () => void;
  readonly openDetails: (skillId: string) => void;
  readonly previewImport: () => Promise<void>;
  readonly publishImport: () => Promise<void>;
  readonly removeBinding: (skillId: string) => Promise<void>;
  readonly requestArchive: (skillId?: string) => void;
  readonly setFilter: (filter: SkillBindingFilter) => void;
  readonly setImportOpen: (open: boolean) => void;
  readonly setManualSkillId: (value: string) => void;
  readonly setSearchQuery: (value: string) => void;
  readonly toggleBinding: (skillId: string) => Promise<void>;
  readonly updateImportForm: (form: SkillImportForm) => void;
}
