import type {
  AutomationDetailResponse,
  AutomationDraftDetailResponse,
  AutomationDraftListRequest,
  AutomationDraftListResponse,
  AutomationDraftMutationResponse,
  AutomationDraftPreviewResponse,
  AutomationListRequest,
  AutomationListResponse,
  AutomationMutationResponse,
  AutomationPreviewResponse,
  AutomationRunCancelRequest,
  AutomationRunDetailResponse,
  AutomationRunListRequest,
  AutomationRunListResponse,
  AutomationRunMutationResponse,
  AutomationRunRequest,
  AutomationSchedulerListResponse,
  AutomationSchedulerMutationResponse,
  ConfirmAutomationDraftResponse,
  CreateAutomationDraftRequest,
  CreateAutomationRequest,
  UpdateAutomationDraftRequest,
  UpdateAutomationRequest,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function listAutomations(cwd: string, options: AutomationListRequest = {}): Promise<AutomationListResponse> {
  return daemonClient.listAutomations(cwd, options);
}

export async function createAutomation(cwd: string, input: CreateAutomationRequest): Promise<AutomationMutationResponse> {
  return daemonClient.createAutomation(cwd, input);
}

export async function listAutomationDrafts(cwd: string, options: AutomationDraftListRequest = {}): Promise<AutomationDraftListResponse> {
  return daemonClient.listAutomationDrafts(cwd, options);
}

export async function createAutomationDraft(cwd: string, input: CreateAutomationDraftRequest): Promise<AutomationDraftMutationResponse> {
  return daemonClient.createAutomationDraft(cwd, input);
}

export async function getAutomationDraft(cwd: string, draftId: string): Promise<AutomationDraftDetailResponse> {
  return daemonClient.getAutomationDraft(cwd, draftId);
}

export async function updateAutomationDraft(
  cwd: string,
  draftId: string,
  input: UpdateAutomationDraftRequest,
): Promise<AutomationDraftMutationResponse> {
  return daemonClient.updateAutomationDraft(cwd, draftId, input);
}

export async function discardAutomationDraft(cwd: string, draftId: string): Promise<AutomationDraftMutationResponse> {
  return daemonClient.discardAutomationDraft(cwd, draftId);
}

export async function previewAutomationDraft(cwd: string, draftId: string): Promise<AutomationDraftPreviewResponse> {
  return daemonClient.previewAutomationDraft(cwd, draftId);
}

export async function confirmAutomationDraft(cwd: string, draftId: string): Promise<ConfirmAutomationDraftResponse> {
  return daemonClient.confirmAutomationDraft(cwd, draftId);
}

export async function getAutomation(cwd: string, automationId: string): Promise<AutomationDetailResponse> {
  return daemonClient.getAutomation(cwd, automationId);
}

export async function updateAutomation(cwd: string, automationId: string, input: UpdateAutomationRequest): Promise<AutomationMutationResponse> {
  return daemonClient.updateAutomation(cwd, automationId, input);
}

export async function archiveAutomation(cwd: string, automationId: string): Promise<AutomationMutationResponse> {
  return daemonClient.archiveAutomation(cwd, automationId);
}

export async function previewAutomation(cwd: string, automationId: string): Promise<AutomationPreviewResponse> {
  return daemonClient.previewAutomation(cwd, automationId);
}

export async function runAutomation(cwd: string, automationId: string, input: AutomationRunRequest = {}): Promise<AutomationRunMutationResponse> {
  return daemonClient.runAutomation(cwd, automationId, input);
}

export async function listAutomationRuns(cwd: string, options: AutomationRunListRequest = {}): Promise<AutomationRunListResponse> {
  return daemonClient.listAutomationRuns(cwd, options);
}

export async function getAutomationRun(cwd: string, automationRunId: string): Promise<AutomationRunDetailResponse> {
  return daemonClient.getAutomationRun(cwd, automationRunId);
}

export async function cancelAutomationRun(
  cwd: string,
  automationRunId: string,
  input: AutomationRunCancelRequest = {},
): Promise<AutomationRunMutationResponse> {
  return daemonClient.cancelAutomationRun(cwd, automationRunId, input);
}

export async function startAutomationScheduler(cwd: string): Promise<AutomationSchedulerMutationResponse> {
  return daemonClient.startAutomationScheduler(cwd);
}

export async function listAutomationSchedulers(cwd: string): Promise<AutomationSchedulerListResponse> {
  return daemonClient.listAutomationSchedulers(cwd);
}

export async function stopAutomationScheduler(cwd: string): Promise<AutomationSchedulerMutationResponse> {
  return daemonClient.stopAutomationScheduler(cwd);
}
