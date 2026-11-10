import { randomUUID } from "node:crypto";
import type {
  CompanionActionSpec,
  CompanionBehaviorPolicy,
  CompanionEmotionSpec,
  CompanionManifest,
  CompanionReply,
} from "@ling-stack/contracts";

export type {
  CompanionActionSpec,
  CompanionBehaviorPolicy,
  CompanionEmotionSpec,
  CompanionEvent,
  CompanionEventType,
  CompanionInteractionRequest,
  CompanionInteractionResponse,
  CompanionManifest,
  CompanionMessageRequest,
  CompanionMessageResponse,
  CompanionMessagesResponse,
  CompanionProactiveRequest,
  CompanionMutationResponse,
  CompanionPhase,
  CompanionProfile,
  CompanionReply,
  CompanionState,
  CompanionStatus,
  CompanionEventsResponse,
  CompanionListResponse,
  CompanionStateResponse,
  CreateCompanionRequest,
  UpdateCompanionRequest,
} from "@ling-stack/contracts";

import type { CompanionEvent, CompanionEventType, CompanionInteractionRequest, CompanionProfile, CompanionState } from "@ling-stack/contracts";

export interface CreateCompanionInput {
  readonly id?: string;
  readonly teammateId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly manifest?: CompanionManifest;
  readonly behaviorPolicy?: Partial<CompanionBehaviorPolicy>;
}

export interface UpdateCompanionInput {
  readonly displayName?: string;
  readonly description?: string;
  readonly manifest?: CompanionManifest;
  readonly behaviorPolicy?: Partial<CompanionBehaviorPolicy>;
  readonly status?: CompanionProfile["status"];
}

export interface ListCompanionsOptions {
  readonly status?: CompanionProfile["status"];
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListCompanionEventsOptions {
  readonly companionId: string;
  readonly limit?: number;
  readonly beforeCreatedAt?: string;
  readonly beforeEventId?: string;
}

export interface CompanionEventPage {
  readonly events: readonly CompanionEvent[];
  readonly hasMore: boolean;
  readonly nextBeforeCreatedAt?: string;
  readonly nextBeforeEventId?: string;
}

export interface UpdateCompanionStateInput {
  readonly phase?: CompanionState["phase"];
  readonly emotionId?: string;
  readonly emotionIntensity?: number;
  readonly energy?: number;
  readonly lastInteractionAt?: string | null;
}

export interface RecordCompanionInteractionInput extends CompanionInteractionRequest {
  readonly companionId: string;
}

export interface RecordCompanionEventInput {
  readonly companionId: string;
  readonly type: CompanionEventType;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface ParsedCompanionReplyText {
  readonly reply: CompanionReply;
  readonly displayText: string;
  readonly metadataPresent: boolean;
  readonly metadataError?: string;
}

export interface RecordCompanionInteractionResult {
  readonly companion: CompanionProfile;
  readonly state: CompanionState;
  readonly event: CompanionEvent;
}

export const companionStatuses = ["active", "paused", "disabled"] as const;
export const companionPhases = ["idle", "thinking", "speaking", "reacting", "error"] as const;
export const companionEventTypes = [
  "message",
  "emotion_changed",
  "action_requested",
  "memory_candidate",
  "presence_changed",
  "proactive_prompt",
  "milestone",
  "error",
] as const;

export const defaultCompanionEmotions: readonly CompanionEmotionSpec[] = [
  { id: "neutral", label: "Neutral" },
  { id: "happy", label: "Happy" },
  { id: "sad", label: "Sad" },
  { id: "excited", label: "Excited" },
  { id: "tired", label: "Tired" },
];

export const defaultCompanionActions: readonly CompanionActionSpec[] = [
  { id: "idle", label: "Idle" },
  { id: "greet", label: "Greet" },
  { id: "think", label: "Think" },
  { id: "celebrate", label: "Celebrate" },
];

export const defaultCompanionManifest: CompanionManifest = {
  version: 1,
  defaultEmotionId: "neutral",
  emotions: defaultCompanionEmotions,
  actions: defaultCompanionActions,
};

export const defaultCompanionBehaviorPolicy: CompanionBehaviorPolicy = {
  proactiveEnabled: false,
  cooldownMs: 60 * 60 * 1000,
};

export function createCompanionId(): string {
  return `companion_${randomUUID()}`;
}

export function createCompanionEventId(): string {
  return `companion_event_${randomUUID()}`;
}

export function normalizeCompanionManifest(manifest?: CompanionManifest): CompanionManifest {
  const value = manifest ?? defaultCompanionManifest;
  const emotionIds = new Set(value.emotions.map((emotion) => emotion.id));
  if (value.version !== 1 || value.emotions.length === 0 || value.actions.length === 0) {
    throw new Error("Companion manifest must define version 1 with at least one emotion and action");
  }
  if (!emotionIds.has(value.defaultEmotionId)) {
    throw new Error(`Companion manifest default emotion is not declared: ${value.defaultEmotionId}`);
  }
  assertUniqueIds(value.emotions.map((emotion) => emotion.id), "emotion");
  assertUniqueIds(value.actions.map((action) => action.id), "action");
  for (const action of value.actions) {
    if (action.cooldownMs !== undefined && (!Number.isInteger(action.cooldownMs) || action.cooldownMs < 0)) {
      throw new Error(`Companion action cooldown must be a non-negative integer: ${action.id}`);
    }
  }
  return value;
}

export function normalizeCompanionBehaviorPolicy(
  policy?: Partial<CompanionBehaviorPolicy>,
): CompanionBehaviorPolicy {
  const cooldownMs = policy?.cooldownMs ?? defaultCompanionBehaviorPolicy.cooldownMs;
  if (!Number.isInteger(cooldownMs) || cooldownMs < 0) {
    throw new Error("Companion cooldownMs must be a non-negative integer");
  }
  if (policy?.quietHours !== undefined) {
    const [start, end] = policy.quietHours;
    if (![start, end].every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)) {
      throw new Error("Companion quietHours must contain hours from 0 through 23");
    }
  }
  return {
    proactiveEnabled: policy?.proactiveEnabled ?? defaultCompanionBehaviorPolicy.proactiveEnabled,
    cooldownMs,
    ...(policy?.quietHours ? { quietHours: policy.quietHours } : {}),
  };
}

export function parseCompanionReply(value: unknown): CompanionReply {
  if (typeof value === "string") {
    return { text: value };
  }
  if (!isRecord(value)) {
    return { text: "" };
  }
  const text = typeof value.text === "string" ? value.text : "";
  const emotion = parseEmotion(value.emotion);
  const actionRequests = Array.isArray(value.actionRequests)
    ? value.actionRequests.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.actionId !== "string" || !entry.actionId.trim()) return [];
        return [{
          actionId: entry.actionId,
          ...(isRecord(entry.arguments) ? { arguments: entry.arguments } : {}),
        }];
      })
    : undefined;
  const memoryCandidates = Array.isArray(value.memoryCandidates)
    ? value.memoryCandidates.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.summary !== "string" || !entry.summary.trim()) return [];
        return [{
          summary: entry.summary,
          ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
        }];
      })
    : undefined;
  return {
    text,
    ...(emotion ? { emotion } : {}),
    ...(actionRequests?.length ? { actionRequests } : {}),
    ...(memoryCandidates?.length ? { memoryCandidates } : {}),
  };
}

/**
 * Parses the provider-facing text format while keeping ordinary text usable.
 * Structured metadata may be a JSON object response or a trailing
 * `LING_COMPANION_META:` JSON object.
 */
export function parseCompanionReplyText(value: string): ParsedCompanionReplyText {
  const source = value.trim();
  if (!source) {
    return { reply: { text: "" }, displayText: "", metadataPresent: false };
  }

  try {
    const parsed = JSON.parse(source) as unknown;
    if (isRecord(parsed)) {
      const reply = parseCompanionReply(parsed);
      return {
        reply,
        displayText: reply.text || "",
        metadataPresent: true,
      };
    }
  } catch {
    // Ordinary natural language is the normal response format.
  }

  const marker = "LING_COMPANION_META:";
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex < 0) {
    return { reply: { text: value }, displayText: value, metadataPresent: false };
  }

  const text = source.slice(0, markerIndex).trim();
  const metadataSource = source.slice(markerIndex + marker.length).trim();
  try {
    const metadata = JSON.parse(metadataSource) as unknown;
    if (!isRecord(metadata)) {
      throw new Error("metadata must be a JSON object");
    }
    const parsed = parseCompanionReply(metadata);
    const displayText = text || parsed.text;
    return {
      reply: { ...parsed, text: displayText },
      displayText,
      metadataPresent: true,
    };
  } catch (error) {
    return {
      reply: { text: value },
      displayText: value,
      metadataPresent: true,
      metadataError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateCompanionAction(manifest: CompanionManifest, actionId: string): void {
  if (!manifest.actions.some((action) => action.id === actionId)) {
    throw new Error(`Companion action is not declared by the manifest: ${actionId}`);
  }
}

export function validateCompanionEmotion(manifest: CompanionManifest, emotionId: string): void {
  if (!manifest.emotions.some((emotion) => emotion.id === emotionId)) {
    throw new Error(`Companion emotion is not declared by the manifest: ${emotionId}`);
  }
}

function parseEmotion(value: unknown): CompanionReply["emotion"] {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const intensity = typeof value.intensity === "number" ? value.intensity : 0.5;
  if (!Number.isFinite(intensity)) return undefined;
  return { id: value.id, intensity: Math.min(1, Math.max(0, intensity)) };
}

function assertUniqueIds(values: readonly string[], kind: string): void {
  if (values.some((value) => !value.trim())) throw new Error(`Companion ${kind} ids cannot be empty`);
  if (new Set(values).size !== values.length) throw new Error(`Companion ${kind} ids must be unique`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
