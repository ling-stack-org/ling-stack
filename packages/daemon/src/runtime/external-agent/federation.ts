import { createHash, randomUUID } from "node:crypto";
import type {
  LingAppServerExternalAgentCapabilitiesResult,
  LingAppServerExternalAgentRegisterParams,
  LingAppServerExternalAgentRegisterResult,
  LingAppServerExternalAgentRegistration,
  LingAppServerExternalAgentTaskCancelParams,
  LingAppServerExternalAgentTaskCancelResult,
  LingAppServerExternalAgentTaskReconnectParams,
  LingAppServerExternalAgentTaskReconnectResult,
  LingAppServerExternalAgentTaskReceipt,
  LingAppServerExternalAgentTaskStartParams,
  LingAppServerExternalAgentTaskStartResult,
} from "@ling-stack/contracts";

/** Capability required before an external Agent can receive a Work Item task. */
export const EXTERNAL_AGENT_TASK_START_CAPABILITIES = [
  "task.start",
  "workItem.dispatch",
  "workItem.task.start",
] as const;

export const EXTERNAL_AGENT_TASK_RECONNECT_CAPABILITY = "task.reconnect";
export const EXTERNAL_AGENT_TASK_CANCEL_CAPABILITY = "task.cancel";

export type ExternalAgentFederationErrorCode =
  | "registration_not_found"
  | "registration_conflict"
  | "capability_denied"
  | "workspace_scope_denied"
  | "task_not_found"
  | "task_conflict"
  | "dispatch_depth_exceeded"
  | "cursor_unavailable"
  | "authorization_changed"
  | "unknown_outcome"
  | "idempotency_conflict";

export class ExternalAgentFederationError extends Error {
  readonly code: ExternalAgentFederationErrorCode;
  readonly retryable: boolean;

  constructor(code: ExternalAgentFederationErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ExternalAgentFederationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ExternalAgentFederationEvent {
  readonly sequence: number;
  readonly cursor: string;
  readonly taskId: string;
  readonly type: "task_started" | "task_status" | "task_event" | "task_cancelled" | "task_unknown";
  readonly payload?: unknown;
  readonly createdAt: string;
}

export interface ExternalAgentFederationRegistrationRecord {
  readonly registrationId: string;
  readonly registration: LingAppServerExternalAgentRegistration;
  readonly acceptedCapabilities: readonly string[];
  readonly deniedCapabilities: readonly string[];
  readonly authorizationEpoch: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface ExternalAgentFederationTaskRecord {
  readonly task: LingAppServerExternalAgentTaskReceipt;
  readonly registrationId: string;
  readonly submissionFingerprint: string;
  readonly submissionIdempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusRevision: number;
}

export interface ExternalAgentFederationSnapshot {
  readonly registrations: readonly ExternalAgentFederationRegistrationRecord[];
  readonly tasks: readonly ExternalAgentFederationTaskRecord[];
  readonly events: readonly ExternalAgentFederationEvent[];
  readonly idempotency: readonly {
    readonly key: string;
    readonly kind: "register" | "start" | "cancel";
    readonly fingerprint: string;
    readonly result: unknown;
  }[];
}

export interface ExternalAgentFederationOptions {
  readonly allowedCapabilities?: readonly string[];
  readonly allowedAdapterKinds?: readonly LingAppServerExternalAgentRegistration["adapterKind"][];
  readonly maxDispatchDepth?: number;
  readonly maxEventsPerTask?: number;
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

interface IdempotencyRecord {
  readonly kind: "register" | "start" | "cancel";
  readonly fingerprint: string;
  readonly result: unknown;
}

/**
 * Admission and recovery ledger for external Agent tasks.
 *
 * The ledger deliberately stops at the dispatch boundary. A daemon owner can
 * call markRunning/markUnknown and appendEvent after its normal Run/Work Item
 * admission. This keeps federation from becoming a second execution state
 * machine while still making registration, idempotency, recursion and cursor
 * semantics deterministic for an App Server adapter.
 */
export class ExternalAgentFederationService {
  private readonly registrations = new Map<string, ExternalAgentFederationRegistrationRecord>();
  private readonly registrationsByAgent = new Map<string, string>();
  private readonly tasks = new Map<string, ExternalAgentFederationTaskRecord>();
  private readonly tasksBySubmission = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly events = new Map<string, ExternalAgentFederationEvent[]>();
  private readonly listeners = new Set<(event: ExternalAgentFederationEvent) => void>();
  private readonly allowedCapabilities: readonly string[];
  private readonly allowedAdapterKinds: readonly LingAppServerExternalAgentRegistration["adapterKind"][];
  private readonly maxDispatchDepth: number;
  private readonly maxEventsPerTask: number;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: ExternalAgentFederationOptions = {}) {
    this.allowedCapabilities = options.allowedCapabilities ?? [
      "stream_text",
      "tool_events",
      "artifacts",
      "sessionLifecycle",
      "textStreaming",
      "cancellation",
      "workspaceBoundary",
      "task.start",
      "task.reconnect",
      "task.cancel",
      "workItem.dispatch",
      "workItem.task.start",
    ];
    this.allowedAdapterKinds = options.allowedAdapterKinds ?? [
      "ling-app-server",
      "codex-app-server",
      "claude-agent",
      "acp",
      "mcp",
      "custom",
    ];
    this.maxDispatchDepth = options.maxDispatchDepth ?? 8;
    this.maxEventsPerTask = options.maxEventsPerTask ?? 256;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  register(params: LingAppServerExternalAgentRegisterParams): LingAppServerExternalAgentRegisterResult {
    const registration = validateRegistration(params.registration);
    const fingerprint = digest({ registration });
    const idempotencyKey = requireNonEmpty(params.idempotencyKey, "idempotencyKey");
    const replay = this.replayIdempotency< LingAppServerExternalAgentRegisterResult>("register", idempotencyKey, fingerprint);
    if (replay) return replay;

    if (!this.allowedAdapterKinds.includes(registration.adapterKind)) {
      throw new ExternalAgentFederationError("capability_denied", `Adapter kind is not allowed: ${registration.adapterKind}`);
    }

    const existingId = this.registrationsByAgent.get(registration.agentId);
    if (existingId) {
      const existing = this.registrations.get(existingId);
      if (existing && digest({ registration: existing.registration }) !== fingerprint) {
        throw new ExternalAgentFederationError("registration_conflict", `Agent is already registered: ${registration.agentId}`);
      }
      if (existing) {
        const result = this.registrationResult(existing);
        this.idempotency.set(idempotencyKey, { kind: "register", fingerprint, result });
        return result;
      }
    }

    const acceptedCapabilities = registration.capabilities.filter(capability => this.allowedCapabilities.includes(capability));
    const deniedCapabilities = registration.capabilities.filter(capability => !this.allowedCapabilities.includes(capability));
    const record: ExternalAgentFederationRegistrationRecord = {
      registrationId: `registration_${this.idFactory()}`,
      registration,
      acceptedCapabilities,
      deniedCapabilities,
      authorizationEpoch: `auth_${this.idFactory()}`,
      createdAt: this.now(),
    };
    this.registrations.set(record.registrationId, record);
    this.registrationsByAgent.set(registration.agentId, record.registrationId);
    const result = this.registrationResult(record);
    this.idempotency.set(idempotencyKey, { kind: "register", fingerprint, result });
    return result;
  }

  readCapabilities(registrationId: string): LingAppServerExternalAgentCapabilitiesResult {
    const record = this.requireRegistration(registrationId);
    if (record.revokedAt) {
      throw new ExternalAgentFederationError("authorization_changed", `External Agent authorization changed: ${registrationId}`);
    }
    return {
      registrationId: record.registrationId,
      capabilities: record.acceptedCapabilities,
      effectiveWorkspaceScopes: record.registration.workspaceScopes,
      effectiveToolScopes: record.registration.toolScopes,
      approvalModes: record.registration.approvalModes,
      authorizationEpoch: record.authorizationEpoch,
    };
  }

  startTask(params: LingAppServerExternalAgentTaskStartParams): LingAppServerExternalAgentTaskStartResult {
    const registration = this.requireRegistration(params.registrationId);
    const submission = validateSubmission(params.submission);
    assertCapability(registration, EXTERNAL_AGENT_TASK_START_CAPABILITIES, "task.start");
    assertWorkspaceScope(registration, submission.workspaceId);
    const dispatchDepth = (submission.parentLineage?.length ?? 0) + 1;
    if (dispatchDepth > this.maxDispatchDepth) {
      throw new ExternalAgentFederationError("dispatch_depth_exceeded", `External Agent dispatch depth ${dispatchDepth} exceeds limit ${this.maxDispatchDepth}`);
    }

    const fingerprint = digest({ registrationId: params.registrationId, submission });
    const idempotencyKey = `${params.registrationId}:${submission.idempotencyKey}`;
    const replay = this.replayIdempotency<LingAppServerExternalAgentTaskStartResult>("start", idempotencyKey, fingerprint);
    if (replay) return replay;

    const existingTaskId = this.tasksBySubmission.get(idempotencyKey);
    if (existingTaskId) {
      const existing = this.tasks.get(existingTaskId);
      if (existing && existing.submissionFingerprint !== fingerprint) {
        throw new ExternalAgentFederationError("idempotency_conflict", `Task submission key was reused with different content: ${submission.idempotencyKey}`);
      }
      if (existing) {
        const result = { task: existing.task } satisfies LingAppServerExternalAgentTaskStartResult;
        this.idempotency.set(idempotencyKey, { kind: "start", fingerprint, result });
        return result;
      }
    }

    const now = this.now();
    const task: LingAppServerExternalAgentTaskReceipt = {
      taskId: `external_task_${this.idFactory()}`,
      submissionId: `submission_${digest({ registrationId: params.registrationId, key: submission.idempotencyKey }).slice(0, 24)}`,
      workItemId: submission.workItemId,
      workItemRevision: submission.workItemRevision,
      status: "accepted",
      eventCursor: makeCursor(0),
      ...(submission.parentLineage?.at(-1) ? { parentRunId: submission.parentLineage.at(-1) } : {}),
      dispatchDepth,
    };
    const record: ExternalAgentFederationTaskRecord = {
      task,
      registrationId: params.registrationId,
      submissionFingerprint: fingerprint,
      submissionIdempotencyKey: submission.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      statusRevision: 0,
    };
    this.tasks.set(task.taskId, record);
    this.tasksBySubmission.set(idempotencyKey, task.taskId);
    const result = { task } satisfies LingAppServerExternalAgentTaskStartResult;
    this.idempotency.set(idempotencyKey, { kind: "start", fingerprint, result });
    this.publish(task.taskId, "task_started", { workItemId: task.workItemId, workItemRevision: task.workItemRevision });
    return result;
  }

  reconnectTask(params: LingAppServerExternalAgentTaskReconnectParams): LingAppServerExternalAgentTaskReconnectResult {
    const registration = this.requireRegistration(params.registrationId, true);
    const task = this.requireTask(params.taskId);
    if (task.registrationId !== params.registrationId || task.task.submissionId !== params.submissionId) {
      throw new ExternalAgentFederationError("task_conflict", "Task does not belong to this registration or submission.");
    }
    if (registration.revokedAt) {
      return { task: task.task, resyncRequired: true, reason: "authorization_changed" };
    }
    assertCapability(registration, [EXTERNAL_AGENT_TASK_RECONNECT_CAPABILITY], EXTERNAL_AGENT_TASK_RECONNECT_CAPABILITY);
    const eventList = this.events.get(task.task.taskId) ?? [];
    const requestedCursor = params.eventCursor;
    const resyncRequired = requestedCursor !== undefined && !isCursorAvailable(eventList, requestedCursor);
    const reason = resyncRequired ? "cursor_unavailable" as const : undefined;
    return {
      task: task.task,
      resyncRequired,
      ...(reason ? { reason } : {}),
    };
  }

  async cancelTask(
    params: LingAppServerExternalAgentTaskCancelParams,
    settle?: (task: ExternalAgentFederationTaskRecord) => Promise<"cancelled" | "unknown">,
  ): Promise<LingAppServerExternalAgentTaskCancelResult> {
    const registration = this.requireRegistration(params.registrationId);
    assertCapability(registration, [EXTERNAL_AGENT_TASK_CANCEL_CAPABILITY], EXTERNAL_AGENT_TASK_CANCEL_CAPABILITY);
    const task = this.requireTask(params.taskId);
    if (task.registrationId !== params.registrationId) {
      throw new ExternalAgentFederationError("task_conflict", "Task does not belong to this registration.");
    }
    const fingerprint = digest({ registrationId: params.registrationId, taskId: params.taskId });
    const replay = this.replayIdempotency<LingAppServerExternalAgentTaskCancelResult>("cancel", params.idempotencyKey, fingerprint);
    if (replay) return replay;
    if (params.expectedTaskRevision !== undefined && params.expectedTaskRevision !== String(task.statusRevision)) {
      throw new ExternalAgentFederationError("task_conflict", `Task revision is stale: expected ${params.expectedTaskRevision}, current ${task.statusRevision}`);
    }
    if (task.task.status === "cancelled") {
      const result = { taskId: task.task.taskId, status: "already_terminal" as const };
      this.idempotency.set(params.idempotencyKey, { kind: "cancel", fingerprint, result });
      return result;
    }
    if (task.task.status === "unknown") {
      const result = { taskId: task.task.taskId, status: "unknown" as const };
      this.idempotency.set(params.idempotencyKey, { kind: "cancel", fingerprint, result });
      return result;
    }
    const outcome = settle ? await settle(task) : "cancelled";
    if (outcome === "unknown") {
      this.replaceTask(task, "unknown");
      this.publish(task.task.taskId, "task_unknown", { reason: "cancellation_outcome_unknown" });
      const result = { taskId: task.task.taskId, status: "unknown" as const };
      this.idempotency.set(params.idempotencyKey, { kind: "cancel", fingerprint, result });
      return result;
    }
    this.replaceTask(task, "cancelled");
    this.publish(task.task.taskId, "task_cancelled");
    const result = { taskId: task.task.taskId, status: "cancelled" as const };
    this.idempotency.set(params.idempotencyKey, { kind: "cancel", fingerprint, result });
    return result;
  }

  markRunning(taskId: string): LingAppServerExternalAgentTaskReceipt {
    const task = this.requireTask(taskId);
    if (task.task.status === "accepted") {
      this.replaceTask(task, "running");
      this.publish(taskId, "task_status", { status: "running" });
    }
    return this.requireTask(taskId).task;
  }

  markUnknown(taskId: string, reason = "external_dispatch_outcome_unknown"): LingAppServerExternalAgentTaskReceipt {
    const task = this.requireTask(taskId);
    this.replaceTask(task, "unknown");
    this.publish(taskId, "task_unknown", { reason });
    return this.requireTask(taskId).task;
  }

  appendEvent(taskId: string, payload: unknown): ExternalAgentFederationEvent {
    this.requireTask(taskId);
    return this.publish(taskId, "task_event", payload);
  }

  getTask(taskId: string): ExternalAgentFederationTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  subscribe(listener: (event: ExternalAgentFederationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  revokeRegistration(registrationId: string): void {
    const current = this.requireRegistration(registrationId);
    const revoked: ExternalAgentFederationRegistrationRecord = {
      ...current,
      authorizationEpoch: `auth_${this.idFactory()}`,
      revokedAt: this.now(),
    };
    this.registrations.set(registrationId, revoked);
  }

  snapshot(): ExternalAgentFederationSnapshot {
    return {
      registrations: [...this.registrations.values()],
      tasks: [...this.tasks.values()],
      events: [...this.events.values()].flat(),
      idempotency: [...this.idempotency.entries()].map(([key, value]) => ({ key, ...value })),
    };
  }

  restore(snapshot: ExternalAgentFederationSnapshot): void {
    this.registrations.clear();
    this.registrationsByAgent.clear();
    this.tasks.clear();
    this.tasksBySubmission.clear();
    this.events.clear();
    this.idempotency.clear();
    for (const registration of snapshot.registrations) {
      this.registrations.set(registration.registrationId, registration);
      this.registrationsByAgent.set(registration.registration.agentId, registration.registrationId);
    }
    for (const task of snapshot.tasks) {
      this.tasks.set(task.task.taskId, task);
      this.tasksBySubmission.set(`${task.registrationId}:${task.submissionIdempotencyKey}`, task.task.taskId);
    }
    for (const event of snapshot.events) {
      const list = this.events.get(event.taskId) ?? [];
      list.push(event);
      this.events.set(event.taskId, list);
    }
    for (const entry of snapshot.idempotency) {
      this.idempotency.set(entry.key, { kind: entry.kind, fingerprint: entry.fingerprint, result: entry.result });
    }
  }

  private registrationResult(record: ExternalAgentFederationRegistrationRecord): LingAppServerExternalAgentRegisterResult {
    return {
      registrationId: record.registrationId,
      agentId: record.registration.agentId,
      acceptedCapabilities: record.acceptedCapabilities,
      deniedCapabilities: record.deniedCapabilities,
      authorizationEpoch: record.authorizationEpoch,
    };
  }

  private requireRegistration(registrationId: string, allowRevoked = false): ExternalAgentFederationRegistrationRecord {
    const record = this.registrations.get(registrationId);
    if (!record) {
      throw new ExternalAgentFederationError("registration_not_found", `External Agent registration was not found: ${registrationId}`);
    }
    if (record.revokedAt && !allowRevoked) {
      throw new ExternalAgentFederationError("authorization_changed", `External Agent authorization changed: ${registrationId}`);
    }
    return record;
  }

  private requireTask(taskId: string): ExternalAgentFederationTaskRecord {
    const record = this.tasks.get(taskId);
    if (!record) throw new ExternalAgentFederationError("task_not_found", `External Agent task was not found: ${taskId}`);
    return record;
  }

  private replaceTask(record: ExternalAgentFederationTaskRecord, status: LingAppServerExternalAgentTaskReceipt["status"]): void {
    const next: ExternalAgentFederationTaskRecord = {
      ...record,
      task: {
        ...record.task,
        status,
      },
      statusRevision: record.statusRevision + 1,
      updatedAt: this.now(),
    };
    this.tasks.set(record.task.taskId, next);
  }

  private publish(taskId: string, type: ExternalAgentFederationEvent["type"], payload?: unknown): ExternalAgentFederationEvent {
    const list = this.events.get(taskId) ?? [];
    const sequence = list.length === 0 ? 1 : list[list.length - 1].sequence + 1;
    const event: ExternalAgentFederationEvent = {
      sequence,
      cursor: makeCursor(sequence),
      taskId,
      type,
      ...(payload === undefined ? {} : { payload }),
      createdAt: this.now(),
    };
    list.push(event);
    while (list.length > this.maxEventsPerTask) list.shift();
    this.events.set(taskId, list);
    const current = this.tasks.get(taskId);
    if (current) {
      this.tasks.set(taskId, {
        ...current,
        task: { ...current.task, eventCursor: event.cursor },
        updatedAt: event.createdAt,
      });
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }

  private replayIdempotency<T>(kind: IdempotencyRecord["kind"], key: string, fingerprint: string): T | undefined {
    const existing = this.idempotency.get(key);
    if (!existing) return undefined;
    if (existing.kind !== kind || existing.fingerprint !== fingerprint) {
      throw new ExternalAgentFederationError("idempotency_conflict", `Idempotency key was reused with a different request: ${key}`);
    }
    return existing.result as T;
  }
}

const federationByContext = new WeakMap<object, ExternalAgentFederationService>();

/** Keep one federation ledger per daemon context so reconnecting App Server
 * connections observe the same registration/task receipts. The daemon may
 * replace this factory with a durable store-backed owner at composition time. */
export function getExternalAgentFederation(context: object): ExternalAgentFederationService {
  const existing = federationByContext.get(context);
  if (existing) return existing;
  const created = new ExternalAgentFederationService();
  federationByContext.set(context, created);
  return created;
}

export function externalAgentRpcError(error: unknown): Error & { readonly jsonRpcCode: number; readonly code: string } {
  if (error instanceof ExternalAgentFederationError) {
    const codeMap: Record<ExternalAgentFederationErrorCode, { readonly jsonRpcCode: number; readonly code: string }> = {
      registration_not_found: { jsonRpcCode: -32040, code: "workspace_binding_invalid" },
      registration_conflict: { jsonRpcCode: -32602, code: "invalid_params" },
      capability_denied: { jsonRpcCode: -32021, code: "capability_denied" },
      workspace_scope_denied: { jsonRpcCode: -32020, code: "authorization_required" },
      task_not_found: { jsonRpcCode: -32040, code: "workspace_binding_invalid" },
      task_conflict: { jsonRpcCode: -32030, code: "stale_revision" },
      dispatch_depth_exceeded: { jsonRpcCode: -32021, code: "capability_denied" },
      cursor_unavailable: { jsonRpcCode: -32070, code: "snapshot_required" },
      authorization_changed: { jsonRpcCode: -32020, code: "authorization_required" },
      unknown_outcome: { jsonRpcCode: -32060, code: "unknown_outcome" },
      idempotency_conflict: { jsonRpcCode: -32031, code: "idempotency_conflict" },
    };
    const mapped = codeMap[error.code];
    return Object.assign(new Error(error.message), mapped);
  }
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
    jsonRpcCode: -32000,
    code: "external_agent_error",
  });
}

function validateRegistration(input: LingAppServerExternalAgentRegistration): LingAppServerExternalAgentRegistration {
  if (!input || typeof input !== "object") throw new ExternalAgentFederationError("registration_conflict", "External Agent registration is required.");
  for (const [name, value] of [["agentId", input.agentId], ["protocolVersion", input.protocolVersion], ["displayName", input.displayName], ["version", input.version]] as const) {
    requireNonEmpty(value, name);
  }
  if (!Array.isArray(input.capabilities) || !Array.isArray(input.workspaceScopes) || !Array.isArray(input.toolScopes) || !Array.isArray(input.approvalModes)) {
    throw new ExternalAgentFederationError("registration_conflict", "External Agent registration scope and capability fields must be arrays.");
  }
  return input;
}

function validateSubmission(input: LingAppServerExternalAgentTaskStartParams["submission"]): LingAppServerExternalAgentTaskStartParams["submission"] {
  for (const [name, value] of [["workItemId", input.workItemId], ["workItemRevision", input.workItemRevision], ["objective", input.objective], ["workspaceId", input.workspaceId], ["instructionManifestDigest", input.instructionManifestDigest], ["idempotencyKey", input.idempotencyKey]] as const) {
    requireNonEmpty(value, name);
  }
  if (input.parentLineage !== undefined && (!Array.isArray(input.parentLineage) || input.parentLineage.some(item => typeof item !== "string" || item.length === 0))) {
    throw new ExternalAgentFederationError("task_conflict", "parentLineage must contain non-empty task or run identifiers.");
  }
  return input;
}

function assertCapability(record: ExternalAgentFederationRegistrationRecord, accepted: readonly string[], label: string): void {
  if (!accepted.some(capability => record.acceptedCapabilities.includes(capability))) {
    throw new ExternalAgentFederationError("capability_denied", `External Agent registration does not provide ${label}.`);
  }
}

function assertWorkspaceScope(record: ExternalAgentFederationRegistrationRecord, workspaceId: string): void {
  const scopes = record.registration.workspaceScopes;
  if (scopes.length > 0 && !scopes.includes("*") && !scopes.includes(workspaceId)) {
    throw new ExternalAgentFederationError("workspace_scope_denied", `External Agent is not authorized for workspace: ${workspaceId}`);
  }
}

function requireNonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExternalAgentFederationError("registration_conflict", `${name} must be a non-empty string.`);
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function makeCursor(sequence: number): string {
  return `external-agent:${sequence}`;
}

function cursorSequence(cursor: string): number | undefined {
  const match = /^external-agent:(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : undefined;
}

function isCursorAvailable(events: readonly ExternalAgentFederationEvent[], cursor: string): boolean {
  if (cursor === "external-agent:0") return true;
  const sequence = cursorSequence(cursor);
  if (sequence === undefined) return false;
  return events.some(event => event.sequence === sequence) || sequence === (events.at(-1)?.sequence ?? 0);
}
