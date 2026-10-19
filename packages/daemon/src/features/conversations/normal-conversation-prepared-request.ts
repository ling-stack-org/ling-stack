import { isDeepStrictEqual } from "node:util";
import {
  redactSecrets,
  type ChannelMessageFileRefSource,
  type ConversationPreparedInputSnapshot,
  type RunStore,
} from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { parseRunRequest, type RunRequest } from "../runs/schemas.js";
import { readNormalConversationRequestContext } from "./normal-conversation-context.js";
import { inlineProviderDescriptor, restorePreparedInlineProvider } from "./normal-conversation-prepared-provider.js";
import { readNativeResponsePreferences } from "./native-response-preferences.js";

const requestKeys = new Set([
  "executionBinding", "workspaceCwd", "cwd", "task", "providerPresetId", "provider", "threadId", "turnId", "teammateId",
  "createdByActor", "tools", "authorizationMode", "workspaceAccessMode", "permissionPreset", "permissionMode",
  "permissionConfirmation", "thinkingLevel", "reasoningSummary", "lingConversationTone", "responseLanguage", "appendSystemPrompt",
  "conversationAttachmentIds", "conversationFileRefs", "normalConversationContext", "normalConversationAcceptedSnapshotId",
  "contextProjection", "idempotencyKey", "runnerId", "requestedSkillId", "skipProviderPreflight", "approvalProfile",
  "systemPrompt", "agentDir", "skipMemoryRecall", "sourceMessageId", "linkedMessageId", "parentRunId",
  "interventionId", "continuationReason", "runtimeToolFeatures", "nativeResponsePreferences",
]);
const internalKeys = new Set(["normalConversationContext", "normalConversationAcceptedSnapshotId", "contextProjection",
  "conversationAttachmentIds", "conversationFileRefs", "createdByActor", "skipMemoryRecall", "sourceMessageId", "linkedMessageId", "nativeResponsePreferences"]);

interface PreparedRequestPayload {
  readonly schemaVersion: 1;
  readonly request: RunRequest;
  readonly inlineProviderSourceRunId?: string;
}

/** Persist the first completed preparation before any Run/WorkUnit dispatch. */
export function saveNormalConversationPreparedRequest(store: RunStore, request: RunRequest, now: string): RunRequest {
  const sourceItemId = request.normalConversationContext?.hydration.source.itemId;
  if (!sourceItemId) throw new Error("Prepared request requires a normal accepted source");
  const accepted = store.getConversationAcceptedInputSnapshot(sourceItemId);
  if (!accepted || request.normalConversationAcceptedSnapshotId !== accepted.id) throw new Error("Prepared request acceptance mismatch");
  assertRequestActor(store, sourceItemId, request);
  if (!isRecord(accepted.payload) || request.normalConversationContext?.fingerprint !== accepted.payload.fingerprint) {
    throw new Error("Prepared request accepted context mismatch");
  }
  // Runtime callbacks and credentials are not JSON evidence. Whitelist before serializing.
  for (const key of Object.keys(request)) if (request[key as keyof RunRequest] !== undefined && !requestKeys.has(key)) {
    throw new Error(`Unsupported prepared request field: ${key}`);
  }
  const payload: PreparedRequestPayload = {
    schemaVersion: 1,
    request: { ...request, ...(request.provider ? { provider: inlineProviderDescriptor(request.provider) } : {}) },
    ...(request.provider ? { inlineProviderSourceRunId: request.parentRunId } : {}),
  };
  // Validate under the store's read-only guard: even accidental getters cannot write state.
  store.readSnapshot(() => {
    const valid = validatePayload(json(payload), { threadId: accepted.threadId, turnId: accepted.turnId, itemId: sourceItemId }, accepted.id);
    if (valid.inlineProviderSourceRunId) restorePreparedInlineProvider(store, valid.request, valid.inlineProviderSourceRunId);
  });
  const saved = store.saveConversationPreparedInput({ sourceItemId, stage: "request", parentSnapshotId: accepted.id,
    parentFingerprint: accepted.fingerprint, payload }, now).snapshot;
  return requestFromSnapshot(store, saved);
}

/** A no-Run retry reads this before materialization or configuration I/O. */
export function readNormalConversationPreparedRequest(store: RunStore, sourceItemId: string, runRequest?: RunRequest): RunRequest | undefined {
  const snapshot = store.getConversationPreparedInput(sourceItemId, "request");
  if (!snapshot) {
    if (runRequest?.normalConversationPreparedRequestRef !== undefined) throw new Error("Prepared request required by Run is missing");
    return undefined;
  }
  const request = requestFromSnapshot(store, snapshot);
  if (runRequest) {
    const ref = runRequest.normalConversationPreparedRequestRef;
    if (!ref || ref.id !== snapshot.id || ref.fingerprint !== snapshot.fingerprint) throw new Error("Prepared request and Run reference mismatch");
    // Orchestrator adds live provider/policy metadata. Compare the original input fields,
    // not that derived metadata. Context/task integrity was also checked against Run facts.
    for (const key of Object.keys(request)) {
      if (key === "provider" || key === "permissionMode" || key === "normalConversationPreparedRequestRef") continue;
      if (!isDeepStrictEqual(json(request[key as keyof RunRequest]), json(runRequest[key as keyof RunRequest]))) {
        throw new Error(`Prepared request and Run input mismatch: ${key}`);
      }
    }
  }
  return request;
}

function requestFromSnapshot(store: RunStore, snapshot: ConversationPreparedInputSnapshot): RunRequest {
  const payload = validatePayload(snapshot.payload, { threadId: snapshot.threadId, turnId: snapshot.turnId, itemId: snapshot.sourceItemId }, snapshot.acceptedSnapshotId);
  assertRequestActor(store, snapshot.sourceItemId, payload.request);
  const accepted = store.getConversationAcceptedInputSnapshot(snapshot.sourceItemId);
  if (!accepted || !isRecord(accepted.payload) || payload.request.normalConversationContext?.fingerprint !== accepted.payload.fingerprint) {
    throw new Error("Prepared request accepted context mismatch");
  }
  const provider = payload.inlineProviderSourceRunId
    ? restorePreparedInlineProvider(store, payload.request, payload.inlineProviderSourceRunId)
    : undefined;
  return freeze({ ...payload.request, ...(provider ? { provider } : {}),
    normalConversationPreparedRequestRef: { id: snapshot.id, fingerprint: snapshot.fingerprint } });
}

function validatePayload(value: unknown, expected: { threadId: string; turnId: string; itemId: string }, acceptedId: string): PreparedRequestPayload {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.request) ||
    Object.keys(value).some((key) => !["schemaVersion", "request", "inlineProviderSourceRunId"].includes(key))) {
    throw new Error("Invalid prepared request payload");
  }
  const request = value.request;
  readNativeResponsePreferences(request.nativeResponsePreferences);
  if (Object.keys(request).some((key) => !requestKeys.has(key))) throw new Error("Invalid prepared request fields");
  const parsed = parseRunRequest(request);
  for (const [key, item] of Object.entries(request)) {
    if (!internalKeys.has(key) && key !== "provider" && !isDeepStrictEqual(item, json(parsed[key as keyof RunRequest]))) {
      throw new Error(`Invalid prepared request value: ${key}`);
    }
  }
  if (request.provider !== undefined) {
    if (!isRecord(request.provider) || "apiKey" in request.provider || "headers" in request.provider ||
      typeof value.inlineProviderSourceRunId !== "string" || !value.inlineProviderSourceRunId ||
      value.inlineProviderSourceRunId !== request.parentRunId) throw new Error("Invalid prepared inline provider source");
    const parsedProvider = json(parsed.provider);
    const thinking = request.provider.thinkingLevelMap;
    if (thinking !== undefined && (!isRecord(thinking) || Object.entries(thinking).some(([key, level]) =>
      !["off", "minimal", "low", "medium", "high", "xhigh"].includes(key) || level !== null && typeof level !== "string"))) {
      throw new Error("Invalid prepared provider thinking map");
    }
    for (const [key, item] of Object.entries(request.provider)) {
      if (key !== "thinkingLevelMap" && (!isRecord(parsedProvider) || !isDeepStrictEqual(parsedProvider[key], item))) {
        throw new Error(`Invalid prepared provider field: ${key}`);
      }
    }
  } else if (value.inlineProviderSourceRunId !== undefined) throw new Error("Unexpected prepared inline provider source");
  if (request.normalConversationAcceptedSnapshotId !== acceptedId || request.teammateId !== "ling_agent" ||
    (request.createdByActor !== "local-user" && request.createdByActor !== "system") || typeof request.idempotencyKey !== "string" || !request.idempotencyKey ||
    !isRecord(request.task) || request.task.channelId !== undefined ||
    request.sourceMessageId !== undefined && request.sourceMessageId !== expected.itemId ||
    request.skipMemoryRecall !== undefined && typeof request.skipMemoryRecall !== "boolean") throw new Error("Prepared request source mismatch");
  for (const key of ["sourceMessageId", "linkedMessageId"]) if (request[key] !== undefined && typeof request[key] !== "string") {
    throw new Error("Invalid prepared request message reference");
  }
  if (request.conversationAttachmentIds !== undefined && (!Array.isArray(request.conversationAttachmentIds) ||
    !request.conversationAttachmentIds.every((id) => typeof id === "string" && id.length > 0))) throw new Error("Invalid prepared attachment references");
  if (request.conversationFileRefs !== undefined && (!Array.isArray(request.conversationFileRefs) ||
    !request.conversationFileRefs.every((ref) => isRecord(ref) && typeof ref.path === "string" && ref.path.length > 0 &&
      Object.keys(ref).every((key) => ["path", "label", "source", "line"].includes(key)) &&
      (ref.label === undefined || typeof ref.label === "string") &&
      (ref.source === undefined || isConversationFileRefSource(ref.source)) &&
      (ref.line === undefined || Number.isInteger(ref.line) && Number(ref.line) > 0)))) throw new Error("Invalid prepared file references");
  readNormalConversationRequestContext(request, expected);
  if (!isDeepStrictEqual(redactSecrets(value), value)) throw new Error("Prepared request contains credentials");
  return structuredClone(value) as unknown as PreparedRequestPayload;
}
/** A persisted system input is not permission to relabel it as local-user guidance. */
function assertRequestActor(store: RunStore, sourceItemId: string, request: RunRequest): void {
  const source = store.getConversationItem(sourceItemId);
  const turn = source?.turnId ? store.getLingTurn(source.turnId) : undefined;
  const actor = source?.actorType === "local_user" ? "local-user" : source?.actorType === "system" ? "system" : undefined;
  if (!actor || !turn || actor !== request.createdByActor || actor !== turn.createdByActor) {
    throw new Error("Prepared request source actor mismatch");
  }
}
function json(value: unknown): unknown { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function isConversationFileRefSource(value: unknown): value is ChannelMessageFileRefSource {
  return value === "composer" || value === "explicit_text" || value === "api";
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
