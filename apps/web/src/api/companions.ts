import type {
  CompanionEventsResponse,
  CompanionInteractionRequest,
  CompanionInteractionResponse,
  CompanionListResponse,
  CompanionMessageRequest,
  CompanionMessageResponse,
  CompanionMessagesResponse,
  CompanionMutationResponse,
  CompanionProactiveResponse,
  CompanionProactiveRequest,
  CompanionStateResponse,
  CreateCompanionRequest,
  UpdateCompanionRequest,
} from "../types.js";
import { daemonClient } from "./client.js";

export function listCompanions(cwd: string): Promise<CompanionListResponse> {
  return daemonClient.listCompanions(cwd);
}

export function getCompanion(cwd: string, companionId: string): Promise<CompanionMutationResponse> {
  return daemonClient.getCompanion(cwd, companionId);
}

export function createCompanion(cwd: string, input: CreateCompanionRequest): Promise<CompanionMutationResponse> {
  return daemonClient.createCompanion(cwd, input);
}

export function updateCompanion(cwd: string, companionId: string, input: UpdateCompanionRequest): Promise<CompanionMutationResponse> {
  return daemonClient.updateCompanion(cwd, companionId, input);
}

export function disableCompanion(cwd: string, companionId: string): Promise<CompanionMutationResponse> {
  return daemonClient.disableCompanion(cwd, companionId);
}

export function getCompanionState(cwd: string, companionId: string): Promise<CompanionStateResponse> {
  return daemonClient.getCompanionState(cwd, companionId);
}

export function listCompanionEvents(
  cwd: string,
  companionId: string,
  options: { readonly limit?: number; readonly beforeCreatedAt?: string; readonly beforeEventId?: string } = {},
): Promise<CompanionEventsResponse> {
  return daemonClient.listCompanionEvents(cwd, companionId, options);
}

export function interactWithCompanion(
  cwd: string,
  companionId: string,
  input: CompanionInteractionRequest,
): Promise<CompanionInteractionResponse> {
  return daemonClient.interactWithCompanion(cwd, companionId, input);
}

export function listCompanionMessages(
  cwd: string,
  companionId: string,
  options: { readonly limit?: number; readonly beforeMessageId?: string } = {},
): Promise<CompanionMessagesResponse> {
  return daemonClient.listCompanionMessages(cwd, companionId, options);
}

export function createCompanionMessage(
  cwd: string,
  companionId: string,
  input: CompanionMessageRequest,
): Promise<CompanionMessageResponse> {
  return daemonClient.createCompanionMessage(cwd, companionId, input);
}

export function streamCompanionMessage(
  cwd: string,
  companionId: string,
  input: CompanionMessageRequest,
): Promise<Response> {
  return daemonClient.streamCompanionMessage(cwd, companionId, input);
}

export function triggerCompanionProactive(
  cwd: string,
  companionId: string,
  input: CompanionProactiveRequest = {},
): Promise<CompanionProactiveResponse> {
  return daemonClient.triggerCompanionProactive(cwd, companionId, input);
}
