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
  readonly connections: readonly MediaWorkflowConnection[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly selectedConnectionId: string;
  readonly selectedWorkflowId: string;
  readonly importDraft?: MediaWorkflowImportDraft;
  readonly isLoading: boolean;
  readonly busyAction: string;
  readonly errorMessage: string;
}

export interface MediaWorkflowControllerActions {
  readonly refresh: () => Promise<void>;
  readonly selectConnection: (connectionId: string) => void;
  readonly selectWorkflow: (workflowId: string) => void;
  readonly createConnection: (input: CreateMediaWorkflowConnectionRequest) => Promise<MediaWorkflowConnection | undefined>;
  readonly updateConnection: (connectionId: string, input: UpdateMediaWorkflowConnectionRequest) => Promise<void>;
  readonly checkConnection: (connectionId: string) => Promise<void>;
  readonly deleteConnection: (connectionId: string) => Promise<void>;
  readonly inspectImportFile: (file: File, connectionId: string) => Promise<void>;
  readonly updateImportDraft: (patch: Partial<Pick<MediaWorkflowImportDraft, "name" | "description" | "inputFields" | "outputRules">>) => void;
  readonly cancelImport: () => void;
  readonly saveImport: () => Promise<MediaWorkflowDefinitionDetail | undefined>;
  readonly testWorkflow: (workflowId: string, versionId: string, inputValues: Record<string, unknown>) => Promise<void>;
  readonly activateWorkflow: (workflowId: string, versionId: string) => Promise<void>;
  readonly archiveWorkflow: (workflowId: string) => Promise<void>;
}
