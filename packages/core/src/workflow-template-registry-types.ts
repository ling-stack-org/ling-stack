import type { CustomWorkflowTemplate, SkillPackSource, SkillRegistryReviewStatus, SkillVisibility,
  WorkflowTemplateRegistryEntry, WorkflowTemplateVersion } from "@ling-stack/contracts";

export type { WorkflowTemplatePin, WorkflowTemplateRegistryEntry, WorkflowTemplateVersion } from "@ling-stack/contracts";

export interface ListWorkflowTemplatesOptions {
  readonly includeArchived?: boolean;
  readonly includeDisabled?: boolean;
  readonly source?: SkillPackSource;
  readonly ownerTeammateId?: string;
  readonly limit?: number;
}

export interface SaveWorkflowTemplateVersionInput {
  readonly kind: "workflow_template";
  readonly id: string;
  readonly version: string;
  readonly template: CustomWorkflowTemplate;
  readonly source: SkillPackSource;
  readonly sourcePath?: string;
  readonly visibility: SkillVisibility;
  /** Zero creates the entry. Every mutation otherwise requires its current revision. */
  readonly expectedRevision: number;
  readonly now: string;
}

export type SetWorkflowTemplateReviewStatusInput = {
  readonly id: string;
  readonly expectedRevision: number;
  readonly now: string;
} & ({ readonly reviewStatus: "published" | "builtin"; readonly version: string; readonly digest: string }
  | { readonly reviewStatus: Exclude<SkillRegistryReviewStatus, "published" | "builtin">; readonly version?: never; readonly digest?: never });

export interface SaveWorkflowTemplateVersionResult {
  readonly status: "created" | "duplicate";
  readonly entry: WorkflowTemplateRegistryEntry;
  readonly version: WorkflowTemplateVersion;
}

export interface WorkflowTemplateRegistryStore {
  list(options?: ListWorkflowTemplatesOptions): readonly WorkflowTemplateRegistryEntry[];
  get(id: string): WorkflowTemplateRegistryEntry | undefined;
  /** Historical lookup only, including disabled/archived entries. Never compile or execution authority. */
  getVersion(id: string, version: string): WorkflowTemplateVersion | undefined;
  /** A new version returns the library entry to draft; no version is implicitly published. */
  saveVersion(input: SaveWorkflowTemplateVersionInput): SaveWorkflowTemplateVersionResult;
  setReviewStatus(input: SetWorkflowTemplateReviewStatusInput): WorkflowTemplateRegistryEntry;
}

export class WorkflowTemplateRegistryError extends Error {
  constructor(readonly code: `workflow_template_registry.${string}`, message = code) {
    super(message); this.name = "WorkflowTemplateRegistryError";
  }
}
