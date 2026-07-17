import type {
  ComputerUseApprovalRequired,
  ComputerUseFailure,
  ComputerUsePreviewDescriptorReference,
  ComputerUsePreviewEvent,
  ComputerUsePreviewEventsResponse,
  ComputerUsePreviewListResponse,
  ComputerUsePreviewProjection,
  ComputerUsePreviewSnapshotResponse,
  ComputerUseTargetMetadata,
  StopComputerUseResponse,
} from "./computer-use.js";
import { isComputerUseRuntimeStatus } from "./computer-use.js";

const COMPUTER_USE_TARGET_KINDS = ["application", "window", "display", "browser"] as const;

export function parseComputerUsePreviewProjection(value: unknown): ComputerUsePreviewProjection | undefined {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.sessionId)
    || !isNonEmptyString(value.conversationId)
    || !isComputerUseRuntimeStatus(value.status)
    || !isTimestamp(value.startedAt)
    || !isTimestamp(value.updatedAt)
  ) {
    return undefined;
  }
  if (
    !isOptionalNonEmptyString(value.turnId)
    || !isOptionalNonEmptyString(value.runId)
    || !isOptionalNonEmptyString(value.workUnitId)
    || !isOptionalTimestamp(value.terminalAt)
  ) {
    return undefined;
  }
  const target = parseTarget(value.target);
  const preview = value.preview === undefined ? undefined : parsePreviewDescriptor(value.preview);
  const approvalRequired = value.approvalRequired === undefined
    ? undefined
    : parseApprovalRequired(value.approvalRequired);
  const failure = value.failure === undefined ? undefined : parseFailure(value.failure);
  if (
    !target
    || (value.preview !== undefined && !preview)
    || (value.approvalRequired !== undefined && !approvalRequired)
    || (value.failure !== undefined && !failure)
  ) {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    conversationId: value.conversationId,
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.workUnitId === undefined ? {} : { workUnitId: value.workUnitId }),
    status: value.status,
    target,
    ...(preview ? { preview } : {}),
    ...(approvalRequired ? { approvalRequired } : {}),
    ...(failure ? { failure } : {}),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(value.terminalAt === undefined ? {} : { terminalAt: value.terminalAt }),
  };
}

export function parseComputerUsePreviewEvent(value: unknown): ComputerUsePreviewEvent | undefined {
  if (
    !isRecord(value)
    || !isNonNegativeInteger(value.seq)
    || (value.kind !== "upsert" && value.kind !== "remove")
    || !isNonEmptyString(value.sessionId)
    || !isTimestamp(value.occurredAt)
  ) {
    return undefined;
  }
  if (value.kind === "remove") {
    return value.projection === undefined
      ? {
          seq: value.seq,
          kind: "remove",
          sessionId: value.sessionId,
          occurredAt: value.occurredAt,
        }
      : undefined;
  }
  const projection = parseComputerUsePreviewProjection(value.projection);
  if (!projection || projection.sessionId !== value.sessionId) {
    return undefined;
  }
  return {
    seq: value.seq,
    kind: "upsert",
    sessionId: value.sessionId,
    projection,
    occurredAt: value.occurredAt,
  };
}

export function parseComputerUsePreviewListResponse(
  value: unknown,
  expectedCwd?: string,
): ComputerUsePreviewListResponse | undefined {
  if (!isRecord(value) || typeof value.cwd !== "string" || !matchesExpected(value.cwd, expectedCwd)) {
    return undefined;
  }
  const projections = parseProjectionArray(value.projections);
  return projections ? { cwd: value.cwd, projections } : undefined;
}

export function parseComputerUsePreviewSnapshotResponse(
  value: unknown,
  expectedCwd?: string,
): ComputerUsePreviewSnapshotResponse | undefined {
  const list = parseComputerUsePreviewListResponse(value, expectedCwd);
  if (!list || !isRecord(value) || !isNonNegativeInteger(value.latestSeq)) {
    return undefined;
  }
  return { ...list, latestSeq: value.latestSeq };
}

export function parseComputerUsePreviewEventsResponse(
  value: unknown,
  expectedCwd?: string,
): ComputerUsePreviewEventsResponse | undefined {
  if (
    !isRecord(value)
    || typeof value.cwd !== "string"
    || !matchesExpected(value.cwd, expectedCwd)
    || !isNonNegativeInteger(value.afterSeq)
    || !isNonNegativeInteger(value.latestSeq)
    || value.latestSeq < value.afterSeq
    || !Array.isArray(value.events)
  ) {
    return undefined;
  }
  const events: ComputerUsePreviewEvent[] = [];
  let previousSeq = value.afterSeq;
  for (const item of value.events) {
    const event = parseComputerUsePreviewEvent(item);
    if (!event || event.seq <= previousSeq || event.seq > value.latestSeq) {
      return undefined;
    }
    previousSeq = event.seq;
    events.push(event);
  }
  return {
    cwd: value.cwd,
    afterSeq: value.afterSeq,
    latestSeq: value.latestSeq,
    events,
  };
}

export function parseStopComputerUseResponse(
  value: unknown,
  expectedSessionId?: string,
): StopComputerUseResponse | undefined {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.sessionId)
    || !matchesExpected(value.sessionId, expectedSessionId)
    || typeof value.accepted !== "boolean"
    || typeof value.acknowledged !== "boolean"
    || (value.acknowledged && !value.accepted)
    || !isNonEmptyString(value.auditId)
    || !isOptionalString(value.reason)
    || !isOptionalTimestamp(value.acknowledgedAt)
  ) {
    return undefined;
  }
  const projection = parseComputerUsePreviewProjection(value.projection);
  if (!projection || projection.sessionId !== value.sessionId) {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    accepted: value.accepted,
    acknowledged: value.acknowledged,
    auditId: value.auditId,
    projection,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.acknowledgedAt === undefined ? {} : { acknowledgedAt: value.acknowledgedAt }),
  };
}

function parseProjectionArray(value: unknown): readonly ComputerUsePreviewProjection[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const projections: ComputerUsePreviewProjection[] = [];
  const sessionIds = new Set<string>();
  for (const item of value) {
    const projection = parseComputerUsePreviewProjection(item);
    if (!projection || sessionIds.has(projection.sessionId)) {
      return undefined;
    }
    sessionIds.add(projection.sessionId);
    projections.push(projection);
  }
  return projections;
}

function parseTarget(value: unknown): ComputerUseTargetMetadata | undefined {
  if (
    !isRecord(value)
    || !isComputerUseTargetKind(value.kind)
    || !isNonEmptyString(value.displayName)
    || !isOptionalNonEmptyString(value.applicationId)
  ) {
    return undefined;
  }
  return {
    kind: value.kind,
    displayName: value.displayName,
    ...(value.applicationId === undefined ? {} : { applicationId: value.applicationId }),
  };
}

function parsePreviewDescriptor(value: unknown): ComputerUsePreviewDescriptorReference | undefined {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.descriptorId)
    || !isNonNegativeInteger(value.revision)
    || typeof value.cursorAvailable !== "boolean"
    || !isOptionalPositiveFiniteNumber(value.aspectRatio)
  ) {
    return undefined;
  }
  return {
    descriptorId: value.descriptorId,
    revision: value.revision,
    ...(value.aspectRatio === undefined ? {} : { aspectRatio: value.aspectRatio }),
    cursorAvailable: value.cursorAvailable,
  };
}

function parseApprovalRequired(value: unknown): ComputerUseApprovalRequired | undefined {
  return isRecord(value) && isNonEmptyString(value.approvalId) && isNonEmptyString(value.summary)
    ? { approvalId: value.approvalId, summary: value.summary }
    : undefined;
}

function parseFailure(value: unknown): ComputerUseFailure | undefined {
  return isRecord(value)
    && isNonEmptyString(value.code)
    && isNonEmptyString(value.message)
    && typeof value.recoverable === "boolean"
    ? { code: value.code, message: value.message, recoverable: value.recoverable }
    : undefined;
}

function isComputerUseTargetKind(value: unknown): value is ComputerUseTargetMetadata["kind"] {
  return typeof value === "string" && (COMPUTER_USE_TARGET_KINDS as readonly string[]).includes(value);
}

function matchesExpected(value: string, expected: string | undefined): boolean {
  return expected === undefined || value === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalPositiveFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isOptionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || isTimestamp(value);
}
