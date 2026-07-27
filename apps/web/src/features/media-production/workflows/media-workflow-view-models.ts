import type {
  MediaJob,
  MediaWorkflowConnection,
  MediaWorkflowDefinitionDetail,
} from "../../../types.js";
import type {
  MediaWorkflowControllerState,
  MediaWorkflowFailure,
  MediaWorkflowFailureOwner,
  MediaWorkflowImportDraft,
  MediaWorkflowTranslationDescriptor,
} from "./media-workflow-types.js";

export interface MediaWorkflowStatusView {
  readonly label: MediaWorkflowTranslationDescriptor;
  readonly tone: "neutral" | "info" | "success" | "warning" | "danger";
}

export interface MediaWorkflowImportValidation {
  readonly issues: readonly MediaWorkflowTranslationDescriptor[];
  readonly technicalMessages: readonly string[];
  readonly canImport: boolean;
}

export function mediaWorkflowBusyKey(owner: string, subjectId?: string): string {
  return subjectId ? `${owner}:${subjectId}` : owner;
}

export function isMediaWorkflowBusy(
  state: Pick<MediaWorkflowControllerState, "busyKeys">,
  owner: string,
  subjectId?: string,
): boolean {
  return state.busyKeys.includes(mediaWorkflowBusyKey(owner, subjectId));
}

export function hasMediaWorkflowMutationBusy(
  state: Pick<MediaWorkflowControllerState, "busyKeys">,
): boolean {
  return state.busyKeys.some((key) => key !== "load");
}

export function isMediaWorkflowSubjectBusy(
  state: Pick<MediaWorkflowControllerState, "busyKeys">,
  subjectKind: "connection" | "workflow",
  subjectId: string,
): boolean {
  return state.busyKeys.some((key) => key.startsWith(`${subjectKind}-`) && key.endsWith(`:${subjectId}`));
}

export function isMediaWorkflowImportBusy(
  state: Pick<MediaWorkflowControllerState, "busyKeys">,
): boolean {
  return state.busyKeys.some((key) => key.startsWith("import-"));
}

export function selectMediaWorkflowFailure(
  failures: readonly MediaWorkflowFailure[],
  owner: MediaWorkflowFailureOwner,
  subjectId?: string,
): MediaWorkflowFailure | undefined {
  return failures.find((failure) => failure.owner === owner && failure.subjectId === subjectId);
}

export function repairMediaWorkflowConnectionSelection(
  connections: readonly MediaWorkflowConnection[],
  currentId: string,
): string {
  if (currentId && connections.some((connection) => connection.id === currentId)) return currentId;
  return connections.find((connection) => connection.status !== "disabled")?.id ?? "";
}

export function repairMediaWorkflowSelection(
  workflows: readonly MediaWorkflowDefinitionDetail[],
  currentId: string,
): string {
  if (currentId && workflows.some((workflow) => workflow.definition.id === currentId)) return currentId;
  return workflows.find((workflow) => workflow.definition.status !== "archived")?.definition.id ?? "";
}

export function referencedWorkflowCount(
  workflows: readonly MediaWorkflowDefinitionDetail[],
  connectionId: string,
): number {
  return workflows.filter((workflow) => workflow.definition.connectionId === connectionId).length;
}

export function deriveMediaWorkflowImportValidation(
  draft: MediaWorkflowImportDraft,
): MediaWorkflowImportValidation {
  const issues: MediaWorkflowTranslationDescriptor[] = [];
  if (draft.analysis.validation.errors.length > 0) issues.push({ key: "Workflow analysis found mapping issues." });
  if (!draft.name.trim()) issues.push({ key: "Enter a workflow name before importing." });
  if (draft.outputRules.length === 0) issues.push({ key: "Choose at least one workflow output." });
  if (draft.inputFields.some((field) => !field.id.trim() || !field.label.trim() || !field.nodeId.trim() || !field.inputName.trim())) {
    issues.push({ key: "Every input mapping needs a label and node field." });
  }
  if (new Set(draft.inputFields.map((field) => field.id)).size !== draft.inputFields.length) {
    issues.push({ key: "Input mapping identifiers must be unique." });
  }
  if (draft.outputRules.some((rule) => !rule.nodeId.trim())) {
    issues.push({ key: "Every output mapping needs a node." });
  }
  const uniqueIssues = uniqueDescriptors(issues);
  return {
    issues: uniqueIssues,
    technicalMessages: unique(draft.analysis.validation.errors),
    canImport: draft.analysis.validation.ok && uniqueIssues.length === 0,
  };
}

export function connectionStatusView(connection: MediaWorkflowConnection): MediaWorkflowStatusView {
  if (connection.status === "ready") return { label: { key: "Ready" }, tone: "success" };
  if (connection.status === "error") return { label: { key: "Needs attention" }, tone: "danger" };
  if (connection.status === "disabled") return { label: { key: "Disabled" }, tone: "neutral" };
  return { label: { key: "Not checked" }, tone: "warning" };
}

export function workflowStatusView(workflow: MediaWorkflowDefinitionDetail): MediaWorkflowStatusView {
  if (workflow.definition.status === "ready") return { label: { key: "Ready" }, tone: "success" };
  if (workflow.definition.status === "blocked") return { label: { key: "Blocked" }, tone: "danger" };
  if (workflow.definition.status === "archived") return { label: { key: "Archived" }, tone: "neutral" };
  return workflow.versions[0]?.testMediaJobId
    ? { label: { key: "Test submitted" }, tone: "info" }
    : { label: { key: "Test required" }, tone: "warning" };
}

export function workflowTestStatusView(job: MediaJob | undefined): MediaWorkflowStatusView {
  if (!job) return { label: { key: "Not tested" }, tone: "neutral" };
  if (job.status === "succeeded") return { label: { key: "Test passed" }, tone: "success" };
  if (job.status === "failed") return { label: { key: "Test failed" }, tone: "danger" };
  if (job.status === "cancelled") return { label: { key: "Test cancelled" }, tone: "neutral" };
  if (job.status === "waiting_for_approval") return { label: { key: "Waiting for approval" }, tone: "warning" };
  if (job.status === "running") return { label: { key: "Test running" }, tone: "info" };
  return { label: { key: "Test queued" }, tone: "info" };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueDescriptors(
  values: readonly MediaWorkflowTranslationDescriptor[],
): readonly MediaWorkflowTranslationDescriptor[] {
  return values.filter((value, index) => values.findIndex((candidate) => candidate.key === value.key) === index);
}
