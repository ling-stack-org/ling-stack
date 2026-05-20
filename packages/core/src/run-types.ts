import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  CreateApprovalRequestInput,
  ListApprovalRequestsOptions,
  ResolveApprovalRequestInput,
} from "./approval-types.js";
import type {
  ListProviderPresetsOptions,
  ProviderPreset,
  ProviderPresetInput,
  ProviderPresetUpdateInput,
} from "./provider-types.js";
import type { LingStackRuntimePaths } from "./runtime-paths.js";

export type RunStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export type RunEventType =
  | "run_created"
  | "run_start"
  | "turn_start"
  | "turn_end"
  | "assistant_text_delta"
  | "assistant_thinking_delta"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "run_end"
  | "run_error"
  | "run_cancelled"
  | "approval_requested"
  | "approval_approved"
  | "approval_denied"
  | "result";

export interface RunSession {
  readonly id: string;
  readonly status: RunStatus;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly eventLogPath: string;
  readonly summaryPath?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt: string;
}

export interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: RunEventType;
  readonly data: unknown;
}

export interface CreateRunInput {
  readonly id: string;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly createdAt: string;
}

export interface ListRunEventsOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface ListRunsOptions {
  readonly status?: RunStatus;
  readonly limit?: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly taskId: string;
  readonly eventCount: number;
  readonly messageCount?: number;
  readonly startedAt?: string;
  readonly endedAt: string;
  readonly errorMessage: string | null;
}

export interface RunStore {
  readonly paths: LingStackRuntimePaths;
  createRun(input: CreateRunInput): RunSession;
  markRunStarted(runId: string, startedAt: string): void;
  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void;
  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void;
  appendEvent(runId: string, type: RunEventType, data: unknown): RunEventEnvelope;
  getRun(runId: string): RunSession | undefined;
  listRuns(options?: ListRunsOptions): RunSession[];
  listEvents(runId: string, options?: ListRunEventsOptions): RunEventEnvelope[];
  countEvents(runId: string): number;
  recoverStaleRuns(now: string): number;
  createProviderPreset(input: ProviderPresetInput, now: string): ProviderPreset;
  getProviderPreset(id: string): ProviderPreset | undefined;
  listProviderPresets(options?: ListProviderPresetsOptions): ProviderPreset[];
  updateProviderPreset(id: string, input: ProviderPresetUpdateInput, now: string): ProviderPreset | undefined;
  deleteProviderPreset(id: string): boolean;
  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest;
  getApprovalRequest(id: string): ApprovalRequest | undefined;
  listApprovalRequests(options?: ListApprovalRequestsOptions): ApprovalRequest[];
  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  close(): void;
}

export function createRunId(): string {
  return `run_${randomUUID()}`;
}

export function createEventId(): string {
  return `evt_${randomUUID()}`;
}
