import type { TeammateDirectMessage, TeammateDirectThread } from "./teammates.js";

/**
 * Contracts for Ling's presentation-independent intelligent companion.
 *
 * A companion owns behavior and presence state while an existing AI teammate
 * owns model selection, private chat, memory, tools, and permissions.
 */

export type CompanionStatus = "active" | "paused" | "disabled";
export type CompanionPhase = "idle" | "thinking" | "speaking" | "reacting" | "error";

export type CompanionEventType =
  | "message"
  | "emotion_changed"
  | "action_requested"
  | "memory_candidate"
  | "presence_changed"
  | "proactive_prompt"
  | "milestone"
  | "error";

export interface CompanionEmotionSpec {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface CompanionActionSpec {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly cooldownMs?: number;
}

export interface CompanionManifest {
  readonly version: 1;
  readonly defaultEmotionId: string;
  readonly emotions: readonly CompanionEmotionSpec[];
  readonly actions: readonly CompanionActionSpec[];
}

export interface CompanionBehaviorPolicy {
  readonly proactiveEnabled: boolean;
  readonly quietHours?: readonly [number, number];
  readonly cooldownMs: number;
}

export interface CompanionProfile {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly displayName: string;
  readonly description: string;
  readonly manifest: CompanionManifest;
  readonly behaviorPolicy: CompanionBehaviorPolicy;
  readonly status: CompanionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompanionState {
  readonly companionId: string;
  readonly phase: CompanionPhase;
  readonly emotionId: string;
  readonly emotionIntensity: number;
  readonly energy: number;
  readonly lastInteractionAt?: string;
  readonly updatedAt: string;
}

export interface CompanionEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly companionId: string;
  readonly type: CompanionEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface CreateCompanionRequest {
  readonly teammateId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly manifest?: CompanionManifest;
  readonly behaviorPolicy?: Partial<CompanionBehaviorPolicy>;
}

export interface UpdateCompanionRequest {
  readonly displayName?: string;
  readonly description?: string;
  readonly manifest?: CompanionManifest;
  readonly behaviorPolicy?: Partial<CompanionBehaviorPolicy>;
  readonly status?: CompanionStatus;
}

export interface CompanionListResponse {
  readonly cwd: string;
  readonly companions: readonly CompanionProfile[];
}

export interface CompanionMutationResponse {
  readonly companion: CompanionProfile;
}

export interface CompanionStateResponse {
  readonly cwd: string;
  readonly companionId: string;
  readonly state: CompanionState;
}

export interface CompanionEventsResponse {
  readonly cwd: string;
  readonly companionId: string;
  readonly events: readonly CompanionEvent[];
  readonly hasMore?: boolean;
  readonly nextBeforeCreatedAt?: string;
  readonly nextBeforeEventId?: string;
}

export interface CompanionInteractionRequest {
  readonly type: Exclude<CompanionEventType, "message" | "memory_candidate" | "proactive_prompt">;
  readonly emotionId?: string;
  readonly emotionIntensity?: number;
  readonly actionId?: string;
  readonly phase?: CompanionPhase;
  readonly energy?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface CompanionInteractionResponse {
  readonly cwd: string;
  readonly companion: CompanionProfile;
  readonly state: CompanionState;
  readonly event: CompanionEvent;
}

export interface CompanionReply {
  readonly text: string;
  readonly emotion?: {
    readonly id: string;
    readonly intensity: number;
  };
  readonly actionRequests?: readonly {
    readonly actionId: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }[];
  readonly memoryCandidates?: readonly {
    readonly summary: string;
    readonly reason?: string;
  }[];
}

export interface CompanionMessageRequest {
  readonly body: string;
  readonly idempotencyKey?: string;
}

export interface CompanionProactiveRequest {
  readonly force?: boolean;
  readonly idempotencyKey?: string;
}

export interface CompanionMessageResponse {
  readonly cwd: string;
  readonly companion: CompanionProfile;
  readonly thread: TeammateDirectThread;
  readonly message: TeammateDirectMessage;
  readonly aiReply?: TeammateDirectMessage;
  readonly companionReply?: CompanionReply;
  readonly state: CompanionState;
}

export interface CompanionProactiveResponse {
  readonly status: "started" | "duplicate" | "skipped";
  readonly cwd: string;
  readonly companion: CompanionProfile;
  readonly reason?: string;
  readonly response?: CompanionMessageResponse;
}

export type CompanionProactiveResult = CompanionProactiveResponse;

export interface CompanionMessagesResponse {
  readonly cwd: string;
  readonly companion: CompanionProfile;
  readonly thread: TeammateDirectThread;
  readonly messages: readonly TeammateDirectMessage[];
  readonly state: CompanionState;
  readonly hasMore?: boolean;
  readonly nextBeforeMessageId?: string;
}
