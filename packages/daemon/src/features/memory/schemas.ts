import type {
  MemoryObjectUpdateInput,
  MemoryRecallIntent,
  MemoryReviewState,
  MemoryScopeType,
  MemorySensitivity,
  MemorySourceRef,
} from "@ling-stack/core";
import {
  isRecord,
  readNullableString,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringArray,
  readString,
  readStringAllowEmpty,
  removeUndefined,
} from "../../shared/validation.js";

export function parseCreateMemoryObjectInput(value: unknown): {
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly retrievalProviderId?: string;
  readonly retrievalHandle?: string;
  readonly createdBy?: string;
} {
  if (!isRecord(value)) {
    throw new Error("Memory request must be a JSON object");
  }
  const input = {
    scopeType: readMemoryScopeType(value, "scopeType"),
    ownerId: readString(value, "ownerId"),
    title: readString(value, "title"),
    body: readString(value, "body"),
    tags: readOptionalStringArray(value, "tags"),
    sourceRefs: readOptionalMemorySourceRefs(value, "sourceRefs"),
    reviewState: readOptionalMemoryReviewState(value, "reviewState"),
    enabled: readOptionalBoolean(value, "enabled"),
    sensitivity: readOptionalMemorySensitivity(value, "sensitivity"),
    retrievalProviderId: readOptionalString(value, "retrievalProviderId"),
    retrievalHandle: readOptionalString(value, "retrievalHandle"),
    createdBy: readOptionalString(value, "createdBy"),
  };
  validateMemoryInput(input);
  return input;
}

export function parseMemoryObjectUpdateInput(value: unknown): MemoryObjectUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Memory update must be a JSON object");
  }
  const input: MemoryObjectUpdateInput = {
    scopeType: readOptionalMemoryScopeType(value, "scopeType"),
    ownerId: readOptionalString(value, "ownerId"),
    title: readOptionalString(value, "title"),
    body: readOptionalString(value, "body"),
    tags: readOptionalStringArray(value, "tags"),
    sourceRefs: readOptionalMemorySourceRefs(value, "sourceRefs"),
    reviewState: readOptionalMemoryReviewState(value, "reviewState"),
    enabled: readOptionalBoolean(value, "enabled"),
    sensitivity: readOptionalMemorySensitivity(value, "sensitivity"),
    retrievalProviderId: readNullableString(value, "retrievalProviderId"),
    retrievalHandle: readNullableString(value, "retrievalHandle"),
    createdBy: readNullableString(value, "createdBy"),
    lastUsedAt: readNullableString(value, "lastUsedAt"),
  };
  validateMemoryInput(input);
  return input;
}

export function parseMemoryRecallRequest(value: unknown): {
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly intent: MemoryRecallIntent;
  readonly query: string;
  readonly tags?: readonly string[];
  readonly maxResults?: number;
  readonly includePrivate?: boolean;
  readonly includeDisabled?: boolean;
  readonly includeSecretAdjacent?: boolean;
} {
  if (!isRecord(value)) {
    throw new Error("Memory recall request must be a JSON object");
  }
  return {
    teammateId: readOptionalString(value, "teammateId"),
    channelId: readOptionalString(value, "channelId"),
    taskId: readOptionalString(value, "taskId"),
    runId: readOptionalString(value, "runId"),
    intent: readMemoryRecallIntent(value, "intent"),
    query: readStringAllowEmpty(value, "query"),
    tags: readOptionalStringArray(value, "tags"),
    maxResults: readOptionalNumber(value, "maxResults"),
    includePrivate: readOptionalBoolean(value, "includePrivate"),
    includeDisabled: readOptionalBoolean(value, "includeDisabled"),
    includeSecretAdjacent: readOptionalBoolean(value, "includeSecretAdjacent"),
  };
}

export function readOptionalMemoryScopeTypeQuery(url: URL): MemoryScopeType | undefined {
  const value = url.searchParams.get("scopeType");
  return value === null ? undefined : requireMemoryScopeType(value, "scopeType");
}

export function readOptionalMemoryReviewStateQuery(url: URL): MemoryReviewState | undefined {
  const value = url.searchParams.get("reviewState");
  if (value === null) {
    return undefined;
  }
  if (value !== "candidate" && value !== "active" && value !== "disabled" && value !== "archived" && value !== "rejected") {
    throw new Error("reviewState must be one of: candidate, active, disabled, archived, rejected");
  }
  return value;
}

export function readOptionalMemorySensitivityQuery(url: URL): MemorySensitivity | undefined {
  const value = url.searchParams.get("sensitivity");
  if (value === null) {
    return undefined;
  }
  if (value !== "normal" && value !== "private" && value !== "secret-adjacent") {
    throw new Error("sensitivity must be one of: normal, private, secret-adjacent");
  }
  return value;
}

function readMemoryScopeType(record: Record<string, unknown>, key: string): MemoryScopeType {
  return requireMemoryScopeType(readString(record, key), key);
}

function readOptionalMemoryScopeType(record: Record<string, unknown>, key: string): MemoryScopeType | undefined {
  const value = readOptionalString(record, key);
  return value === undefined ? undefined : requireMemoryScopeType(value, key);
}

function requireMemoryScopeType(value: string, key: string): MemoryScopeType {
  if (value !== "workspace" && value !== "channel" && value !== "teammate" && value !== "task" && value !== "run") {
    throw new Error(`${key} must be one of: workspace, channel, teammate, task, run`);
  }
  return value;
}

function readOptionalMemoryReviewState(record: Record<string, unknown>, key: string): MemoryReviewState | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "candidate" && value !== "active" && value !== "disabled" && value !== "archived" && value !== "rejected") {
    throw new Error(`${key} must be one of: candidate, active, disabled, archived, rejected`);
  }
  return value;
}

function readOptionalMemorySensitivity(record: Record<string, unknown>, key: string): MemorySensitivity | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "normal" && value !== "private" && value !== "secret-adjacent") {
    throw new Error(`${key} must be one of: normal, private, secret-adjacent`);
  }
  return value;
}

function readMemoryRecallIntent(record: Record<string, unknown>, key: string): MemoryRecallIntent {
  const value = readString(record, key);
  if (value !== "private-chat" && value !== "channel-reply" && value !== "task-run" && value !== "review" && value !== "search") {
    throw new Error(`${key} must be one of: private-chat, channel-reply, task-run, review, search`);
  }
  return value;
}

function readOptionalMemorySourceRefs(record: Record<string, unknown>, key: string): MemorySourceRef[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const type = readString(item, "type");
    if (
      type !== "manual" &&
      type !== "message" &&
      type !== "decision" &&
      type !== "doc" &&
      type !== "attachment" &&
      type !== "run-event" &&
      type !== "artifact" &&
      type !== "import"
    ) {
      throw new Error(`${key}[${index}].type is not supported`);
    }
    return removeUndefined({
      type,
      id: readString(item, "id"),
      label: readOptionalString(item, "label"),
      url: readOptionalString(item, "url"),
    }) as MemorySourceRef;
  });
}

function validateMemoryInput(input: Partial<Pick<MemoryObjectUpdateInput, "ownerId" | "title" | "body" | "tags">>): void {
  if (input.ownerId !== undefined && input.ownerId.trim().length === 0) {
    throw new Error("ownerId must be a non-empty string");
  }
  if (input.title !== undefined && input.title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (input.body !== undefined && input.body.trim().length === 0) {
    throw new Error("body must be a non-empty string");
  }
  if (input.tags?.some((tag) => !tag.trim())) {
    throw new Error("tags entries must be non-empty strings");
  }
}
