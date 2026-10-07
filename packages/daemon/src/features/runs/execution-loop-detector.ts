import { createHash } from "node:crypto";
import type { RunEventDataByType, RunEventEnvelope } from "@ling-stack/core";

export interface ExecutionLoopDetectorLimits {
  readonly exactRepeatThreshold: number;
  readonly repeatedUpdateThreshold: number;
  readonly cycleRepeatThreshold: number;
  readonly maxCycleLength: number;
  readonly noProgressActionBudget: number;
  readonly maxTrackedToolCalls: number;
  readonly maxHistoryEntries: number;
  readonly maxEvidenceFingerprints: number;
}

export interface ExecutionLoopFinding {
  readonly event: RunEventDataByType["loop_detected"];
}

const DEFAULT_LIMITS: ExecutionLoopDetectorLimits = Object.freeze({
  exactRepeatThreshold: 3,
  repeatedUpdateThreshold: 6,
  cycleRepeatThreshold: 3,
  maxCycleLength: 4,
  noProgressActionBudget: 12,
  maxTrackedToolCalls: 128,
  maxHistoryEntries: 32,
  maxEvidenceFingerprints: 256,
});

interface ToolCallState {
  readonly actionFingerprint: string;
  readonly toolNameFingerprint: string;
  lastUpdateFingerprint?: string;
  repeatedUpdateCount: number;
}

type ObservedEvent = Pick<RunEventEnvelope, "type" | "data" | "seq">;

/**
 * Attempt-local progress circuit breaker.
 *
 * It observes only durable, redacted Run events. The detector keeps bounded
 * hashes and counters; it never retains or emits raw tool arguments/results.
 */
export class ExecutionLoopDetector {
  private readonly limits: ExecutionLoopDetectorLimits;
  private readonly toolCalls = new Map<string, ToolCallState>();
  private readonly completedHistory: string[] = [];
  private readonly evidenceFingerprints = new Set<string>();
  private readonly evidenceOrder: string[] = [];
  private lastCompletedFingerprint?: string;
  private exactRepeatCount = 0;
  private noProgressActionCount = 0;
  private finding?: ExecutionLoopFinding;

  constructor(
    private readonly attemptId: string,
    overrides: Partial<ExecutionLoopDetectorLimits> = {},
  ) {
    if (!attemptId.trim()) throw new Error("Execution loop detector requires an attempt id.");
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...overrides });
  }

  observe(event: ObservedEvent): ExecutionLoopFinding | undefined {
    if (this.finding) return this.finding;
    if (event.type === "tool_start") return this.observeToolStart(event);
    if (event.type === "tool_update") return this.observeToolUpdate(event);
    if (event.type === "tool_end") return this.observeToolEnd(event);
    if (isProgressEvent(event.type)) this.recordEvidence(fingerprint({ type: event.type, data: event.data }));
    return undefined;
  }

  private observeToolStart(event: ObservedEvent): ExecutionLoopFinding | undefined {
    const toolCallId = readText(event.data, "toolCallId") ?? `missing:${event.seq}`;
    const toolName = readText(event.data, "toolName") ?? "unknown";
    const state: ToolCallState = {
      actionFingerprint: fingerprint({ toolName, args: readField(event.data, "args") }),
      toolNameFingerprint: fingerprint(toolName),
      repeatedUpdateCount: 0,
    };
    this.toolCalls.delete(toolCallId);
    this.toolCalls.set(toolCallId, state);
    while (this.toolCalls.size > this.limits.maxTrackedToolCalls) {
      const oldest = this.toolCalls.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.toolCalls.delete(oldest);
    }
    this.noProgressActionCount += 1;
    if (this.noProgressActionCount >= this.limits.noProgressActionBudget) {
      return this.detect(event, "no_progress_budget", state.actionFingerprint,
        this.noProgressActionCount, undefined,
        `Execution stopped after ${this.noProgressActionCount} tool actions produced no new durable evidence.`);
    }
    return undefined;
  }

  private observeToolUpdate(event: ObservedEvent): ExecutionLoopFinding | undefined {
    const toolCallId = readText(event.data, "toolCallId") ?? `missing:${event.seq}`;
    const toolName = readText(event.data, "toolName") ?? "unknown";
    const state = this.toolCalls.get(toolCallId) ?? {
      actionFingerprint: fingerprint({ toolName, args: undefined }),
      toolNameFingerprint: fingerprint(toolName),
      repeatedUpdateCount: 0,
    };
    const updateFingerprint = fingerprint({
      toolNameFingerprint: state.toolNameFingerprint,
      partialResult: readField(event.data, "partialResult"),
    });
    state.repeatedUpdateCount = state.lastUpdateFingerprint === updateFingerprint
      ? state.repeatedUpdateCount + 1
      : 1;
    state.lastUpdateFingerprint = updateFingerprint;
    this.toolCalls.set(toolCallId, state);
    if (state.repeatedUpdateCount >= this.limits.repeatedUpdateThreshold) {
      return this.detect(event, "repeated_update", updateFingerprint,
        state.repeatedUpdateCount, undefined,
        `Execution stopped after the same tool update repeated ${state.repeatedUpdateCount} times.`);
    }
    this.recordEvidence(updateFingerprint);
    return undefined;
  }

  private observeToolEnd(event: ObservedEvent): ExecutionLoopFinding | undefined {
    const toolCallId = readText(event.data, "toolCallId") ?? `missing:${event.seq}`;
    const toolName = readText(event.data, "toolName") ?? "unknown";
    const state = this.toolCalls.get(toolCallId) ?? {
      actionFingerprint: fingerprint({ toolName, args: undefined }),
      toolNameFingerprint: fingerprint(toolName),
      repeatedUpdateCount: 0,
    };
    this.toolCalls.delete(toolCallId);
    const resultFingerprint = fingerprint({
      toolNameFingerprint: state.toolNameFingerprint,
      result: readField(event.data, "result"),
      isError: readField(event.data, "isError") === true,
    });
    const completedFingerprint = fingerprint({
      actionFingerprint: state.actionFingerprint,
      resultFingerprint,
    });
    this.recordEvidence(resultFingerprint);
    this.exactRepeatCount = completedFingerprint === this.lastCompletedFingerprint
      ? this.exactRepeatCount + 1
      : 1;
    this.lastCompletedFingerprint = completedFingerprint;
    this.completedHistory.push(completedFingerprint);
    if (this.completedHistory.length > this.limits.maxHistoryEntries) this.completedHistory.shift();
    if (this.exactRepeatCount >= this.limits.exactRepeatThreshold) {
      return this.detect(event, "exact_repeat", completedFingerprint,
        this.exactRepeatCount, 1,
        `Execution stopped after the same tool action and result repeated ${this.exactRepeatCount} times.`);
    }
    const cycle = detectRepeatedCycle(this.completedHistory, this.limits);
    if (cycle) {
      return this.detect(event, "cycle", fingerprint(cycle.pattern), cycle.repeatedCount,
        cycle.cycleLength,
        `Execution stopped after a ${cycle.cycleLength}-action cycle repeated ${cycle.repeatedCount} times.`);
    }
    return undefined;
  }

  private recordEvidence(evidenceFingerprint: string): void {
    if (this.evidenceFingerprints.has(evidenceFingerprint)) return;
    this.evidenceFingerprints.add(evidenceFingerprint);
    this.evidenceOrder.push(evidenceFingerprint);
    while (this.evidenceOrder.length > this.limits.maxEvidenceFingerprints) {
      const oldest = this.evidenceOrder.shift();
      if (oldest) this.evidenceFingerprints.delete(oldest);
    }
    this.noProgressActionCount = 0;
  }

  private detect(
    event: ObservedEvent,
    loopKind: RunEventDataByType["loop_detected"]["loopKind"],
    detectedFingerprint: string,
    repeatedCount: number,
    cycleLength: number | undefined,
    message: string,
  ): ExecutionLoopFinding {
    this.finding = {
      event: {
        code: "execution_loop_detected",
        attemptId: this.attemptId,
        loopKind,
        observedEventType: event.type as RunEventDataByType["loop_detected"]["observedEventType"],
        observedEventSeq: event.seq,
        repeatedCount,
        noProgressActionCount: this.noProgressActionCount,
        ...(cycleLength === undefined ? {} : { cycleLength }),
        fingerprint: detectedFingerprint,
        message,
        retryable: false,
      },
    };
    return this.finding;
  }
}

function detectRepeatedCycle(
  history: readonly string[],
  limits: ExecutionLoopDetectorLimits,
): { readonly pattern: readonly string[]; readonly cycleLength: number; readonly repeatedCount: number } | undefined {
  for (let cycleLength = 2; cycleLength <= limits.maxCycleLength; cycleLength += 1) {
    const required = cycleLength * limits.cycleRepeatThreshold;
    if (history.length < required) continue;
    const suffix = history.slice(-required);
    const pattern = suffix.slice(0, cycleLength);
    if (new Set(pattern).size < 2) continue;
    if (suffix.every((value, index) => value === pattern[index % cycleLength])) {
      return { pattern, cycleLength, repeatedCount: limits.cycleRepeatThreshold };
    }
  }
  return undefined;
}

function isProgressEvent(type: RunEventEnvelope["type"]): boolean {
  return type === "artifact_created"
    || type === "host_command_settled"
    || type === "approval_requested"
    || type === "approval_approved"
    || type === "approval_denied"
    || type === "approval_expired"
    || type === "approval_cancelled"
    || type === "workspace_change_recovery_started"
    || type === "workspace_changes_undone"
    || type === "workspace_changes_reapplied";
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === "string" && field.trim() ? field : undefined;
}

function fingerprint(value: unknown): string {
  return sha256(canonicalValue(value, 0, new WeakSet<object>()));
}

function canonicalValue(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string:${value.length}:${sha256(value)}`;
  if (typeof value === "number") return Number.isFinite(value) ? `number:${value}` : `number:${String(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "symbol") return `symbol:${String(value.description ?? "")}`;
  if (typeof value === "function") return "function";
  if (depth >= 6) return `depth:${objectTag(value)}`;
  if (seen.has(value)) return "circular";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, 64).map((item) => canonicalValue(item, depth + 1, seen));
      return `array:${value.length}:[${items.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.slice(0, 64).map((key) => `${sha256(key)}=${canonicalValue(record[key], depth + 1, seen)}`);
    return `object:${keys.length}:{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function objectTag(value: object): string {
  return Object.prototype.toString.call(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateLimits(limits: ExecutionLoopDetectorLimits): ExecutionLoopDetectorLimits {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid execution loop limit: ${key}`);
  }
  if (limits.maxCycleLength < 2) throw new Error("Execution loop maxCycleLength must be at least 2.");
  return Object.freeze(limits);
}
