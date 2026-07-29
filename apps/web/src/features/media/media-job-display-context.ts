import type { MediaJobDisplayContext } from "./media-job-types.js";

export interface MediaJobHostActions {
  readonly openWorkflow: (workflowDefinitionId?: string) => void;
  readonly openWorkflowConnection: (connectionId?: string) => void;
}

export type MediaJobDisplayContextMap = Readonly<Record<string, MediaJobDisplayContext>>;

export type { MediaJobDisplayContext } from "./media-job-types.js";
