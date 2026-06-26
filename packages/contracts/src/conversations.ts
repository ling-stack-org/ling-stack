import type { PermissionPreset, RunThinkingLevel, RunTool, SessionPermissionMode } from "./shared.js";
import type { ResponseLanguagePreference } from "./settings.js";
import type { RunEventEnvelope, RunSession } from "./runtime.js";
import type { LingThread } from "./threads.js";
import type { LingTurn } from "./turns.js";

export type ConversationTranscriptRole = "user" | "assistant" | "system";
export type ConversationTranscriptStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";

export interface ConversationTranscriptMessage {
  readonly id: string;
  readonly role: ConversationTranscriptRole;
  readonly authorId?: string;
  readonly authorLabel?: string;
  readonly content: string;
  readonly status: ConversationTranscriptStatus;
  readonly threadId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationStreamRequest {
  readonly threadId?: string;
  readonly message: string;
  readonly projectPath?: string;
  readonly providerPresetId: string;
  readonly thinkingLevel?: RunThinkingLevel;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly tools?: readonly RunTool[];
  readonly idempotencyKey?: string;
}

export interface ConversationStreamReadyEvent {
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly userMessage: ConversationTranscriptMessage;
  readonly assistantMessage: ConversationTranscriptMessage;
  readonly runId?: string;
}

export interface ConversationStreamRunEvent {
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly event: RunEventEnvelope;
  readonly assistantMessage?: ConversationTranscriptMessage;
}

export interface ConversationStreamDoneEvent {
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly run: RunSession;
  readonly assistantMessage: ConversationTranscriptMessage;
}

export interface ConversationStreamBlockedEvent {
  readonly thread?: LingThread;
  readonly turn?: LingTurn;
  readonly run?: RunSession;
  readonly assistantMessage?: ConversationTranscriptMessage;
  readonly error: string;
}

export interface ConversationDetailResponse {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
  readonly messages: readonly ConversationTranscriptMessage[];
  readonly defaults: {
    readonly projectPath?: string;
    readonly providerPresetId?: string;
    readonly thinkingLevel?: RunThinkingLevel;
    readonly permissionPreset?: PermissionPreset;
    readonly permissionMode?: SessionPermissionMode;
  };
}
