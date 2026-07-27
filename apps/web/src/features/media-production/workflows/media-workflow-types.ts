import type {
  CreateMediaWorkflowConnectionRequest,
  MediaWorkflowAnalysis,
  MediaWorkflowConnection,
  MediaWorkflowDefinitionDetail,
  MediaWorkflowInputField,
  MediaWorkflowOutputRule,
  UpdateMediaWorkflowConnectionRequest,
} from "../../../types.js";

export type MediaWorkflowLibraryTab = "workflows" | "connections";
export type MediaWorkflowLibraryDetail = "workflow" | "import";
export type MediaWorkflowResourcePhase =
  | "idle"
  | "initial-loading"
  | "ready"
  | "refreshing"
  | "initial-error"
  | "retained-error";

export type MediaWorkflowFailureOwner =
  | "load"
  | "connection-create"
  | "connection-update"
  | "connection-check"
  | "connection-delete"
  | "import-analyze"
  | "import-save"
  | "workflow-test"
  | "workflow-activate"
  | "workflow-archive";

export type MediaWorkflowMutationReason = "in_flight" | "invalid" | "stale" | "failed";

export interface MediaWorkflowTranslationDescriptor {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface MediaWorkflowFailure {
  readonly owner: MediaWorkflowFailureOwner;
  readonly subjectId?: string;
  readonly productMessageKey: string;
  readonly productMessageValues?: Readonly<Record<string, string | number>>;
  readonly technicalMessage?: string;
}

export interface MediaWorkflowMutationOutcome<T = undefined> {
  readonly ok: boolean;
  readonly reason?: MediaWorkflowMutationReason;
  readonly value?: T;
}

export interface MediaWorkflowImportDraft {
  readonly connectionId: string;
  readonly fileName: string;
  readonly name: string;
  readonly description: string;
  readonly graph: Record<string, unknown>;
  readonly analysis: MediaWorkflowAnalysis;
  readonly inputFields: readonly MediaWorkflowInputField[];
  readonly outputRules: readonly MediaWorkflowOutputRule[];
}

export interface MediaWorkflowControllerState {
  readonly workspaceEpoch: number;
  readonly phase: MediaWorkflowResourcePhase;
  readonly connections: readonly MediaWorkflowConnection[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly selectedConnectionId: string;
  readonly selectedWorkflowId: string;
  readonly libraryDetail: MediaWorkflowLibraryDetail;
  readonly importDraft?: MediaWorkflowImportDraft;
  readonly busyKeys: readonly string[];
  /** Compatibility projection for the S0 Workspace close guard; feature UI must use busyKeys. */
  readonly busyAction: string;
  readonly failures: readonly MediaWorkflowFailure[];
}

export interface MediaWorkflowControllerActions {
  readonly refresh: () => Promise<MediaWorkflowMutationOutcome>;
  readonly clearFailure: (owner: MediaWorkflowFailureOwner, subjectId?: string) => void;
  readonly selectConnection: (connectionId: string) => void;
  readonly selectWorkflow: (workflowId: string) => void;
  readonly showImportDraft: () => void;
  readonly createConnection: (
    input: CreateMediaWorkflowConnectionRequest,
  ) => Promise<MediaWorkflowMutationOutcome<MediaWorkflowConnection>>;
  readonly updateConnection: (
    connectionId: string,
    input: UpdateMediaWorkflowConnectionRequest,
  ) => Promise<MediaWorkflowMutationOutcome<MediaWorkflowConnection>>;
  readonly checkConnection: (
    connectionId: string,
  ) => Promise<MediaWorkflowMutationOutcome<MediaWorkflowConnection>>;
  readonly deleteConnection: (connectionId: string) => Promise<MediaWorkflowMutationOutcome>;
  readonly inspectImportFile: (file: File, connectionId: string) => Promise<MediaWorkflowMutationOutcome>;
  readonly updateImportDraft: (
    patch: Partial<Pick<MediaWorkflowImportDraft, "name" | "description" | "inputFields" | "outputRules">>,
  ) => void;
  readonly cancelImport: () => void;
  readonly saveImport: () => Promise<MediaWorkflowMutationOutcome<MediaWorkflowDefinitionDetail>>;
  readonly testWorkflow: (
    workflowId: string,
    versionId: string,
    inputValues: Record<string, unknown>,
  ) => Promise<MediaWorkflowMutationOutcome>;
  readonly activateWorkflow: (
    workflowId: string,
    versionId: string,
  ) => Promise<MediaWorkflowMutationOutcome<MediaWorkflowDefinitionDetail>>;
  readonly archiveWorkflow: (
    workflowId: string,
  ) => Promise<MediaWorkflowMutationOutcome<MediaWorkflowDefinitionDetail>>;
}
