import { randomUUID } from "node:crypto";
import type {
  ComputerUsePreviewProjection,
  ComputerUseRuntimeStatus,
} from "@ling-stack/contracts";
import type { RunEventEnvelope } from "@ling-stack/core";
import type {
  PiRunnerMcpToolDefinition,
  PiRunnerMcpToolCallRequest,
  PiRunnerMcpToolCallResult,
} from "@ling-stack/runner-pi";
import type { ComputerUseProjectionRegistry } from "./registry.js";

const DESCRIPTOR_GRANT_TTL_MS = 15 * 60 * 1_000;

type ActiveComputerUseRuntimeStatus = Extract<
  ComputerUseRuntimeStatus,
  "starting" | "running" | "waiting_for_approval" | "paused"
>;

interface CuaDriverCaptureTarget {
  readonly processId: number;
  readonly nativeWindowId: string;
  readonly displayName: string;
  readonly applicationId?: string;
  readonly aspectRatio?: number;
}

export interface CuaDriverComputerUseProjectionProducerOptions {
  readonly registry: ComputerUseProjectionRegistry;
  readonly cwd: string;
  readonly runId: string;
  readonly workUnitId?: string;
  readonly conversationId: string;
  readonly turnId?: string;
  readonly startedAt: string;
  readonly eligibleServerIds: readonly string[];
  readonly platform?: "macos" | "windows";
  readonly now?: () => Date;
  readonly createDescriptorId?: () => string;
}

export class CuaDriverComputerUseProjectionProducer {
  private readonly now: () => Date;
  private readonly createDescriptorId: () => string;
  private readonly eligibleServerIds: ReadonlySet<string>;
  private readonly sessionId: string;
  private descriptorId: string | undefined;
  private descriptorRevision = 0;
  private currentTarget: CuaDriverCaptureTarget | undefined;
  private readonly cuaToolCallIds = new Set<string>();
  private readonly cuaApprovalIds = new Set<string>();

  constructor(private readonly options: CuaDriverComputerUseProjectionProducerOptions) {
    this.now = options.now ?? (() => new Date());
    this.createDescriptorId = options.createDescriptorId ?? (() => `computer_use_descriptor_${randomUUID()}`);
    this.eligibleServerIds = new Set(options.eligibleServerIds);
    this.sessionId = `computer_use_${options.runId}`;
  }

  beginProviderIntent(input: {
    readonly request: Pick<PiRunnerMcpToolCallRequest, "toolCallId">;
    readonly definition: PiRunnerMcpToolDefinition;
  }): ComputerUsePreviewProjection | undefined {
    if (!this.isEligibleProviderDefinition(input.definition)) {
      return undefined;
    }
    this.cuaToolCallIds.add(input.request.toolCallId);
    const current = this.currentProjection();
    if (current && !isTerminalProjection(current)) {
      return current;
    }
    return this.publishActiveStatus("starting");
  }

  markProviderCallStarted(input: {
    readonly request: Pick<PiRunnerMcpToolCallRequest, "toolCallId">;
    readonly definition: PiRunnerMcpToolDefinition;
  }): ComputerUsePreviewProjection | undefined {
    if (!this.beginProviderIntent(input)) {
      return undefined;
    }
    return this.publishActiveStatus("running");
  }

  observeRunEvent(event: RunEventEnvelope): ComputerUsePreviewProjection | undefined {
    if (event.runId !== this.options.runId || !isRecord(event.data)) {
      return undefined;
    }
    if (event.type === "approval_requested") {
      const toolCallId = readNonEmptyString(event.data.toolCallId);
      const approvalId = readNonEmptyString(event.data.approvalId);
      if (!toolCallId || !approvalId || !this.cuaToolCallIds.has(toolCallId)) {
        return undefined;
      }
      this.cuaApprovalIds.add(approvalId);
      return this.publishActiveStatus("waiting_for_approval", {
        approvalRequired: {
          approvalId,
          summary: readNonEmptyString(event.data.title)
            ?? readNonEmptyString(event.data.description)
            ?? "Computer Use needs approval to continue.",
        },
      });
    }
    if (
      event.type !== "approval_approved"
      && event.type !== "approval_denied"
      && event.type !== "approval_expired"
    ) {
      return undefined;
    }
    const approvalId = readNonEmptyString(event.data.approvalId);
    if (!approvalId || !this.cuaApprovalIds.delete(approvalId)) {
      return undefined;
    }
    if (event.type === "approval_approved") {
      return this.publishActiveStatus("starting");
    }
    this.finish(
      "failed",
      readNonEmptyString(event.data.decisionReason)
        ?? (event.type === "approval_expired" ? "Computer Use approval expired." : "Computer Use approval was denied."),
    );
    return this.currentProjection();
  }

  observeToolResult(input: {
    readonly request: PiRunnerMcpToolCallRequest;
    readonly definition: PiRunnerMcpToolDefinition;
    readonly result: PiRunnerMcpToolCallResult;
  }): ComputerUsePreviewProjection | undefined {
    if (
      !this.isEligibleProviderDefinition(input.definition) ||
      input.result.isError === true
    ) {
      return undefined;
    }
    const target = extractCaptureTarget(input.request.input, input.result, this.currentTarget);
    if (!target) {
      return undefined;
    }

    const targetChanged = !this.currentTarget || targetKey(this.currentTarget) !== targetKey(target);
    this.currentTarget = target;
    this.descriptorId ??= this.createDescriptorId();
    if (targetChanged) {
      this.descriptorRevision += 1;
    }

    const updatedAt = this.nextUpdatedAt();
    const expiresAt = new Date(Date.parse(updatedAt) + DESCRIPTOR_GRANT_TTL_MS).toISOString();
    this.options.registry.registerPrivateDescriptor(this.options.cwd, {
      descriptorId: this.descriptorId,
      revision: this.descriptorRevision,
      platform: this.options.platform ?? (process.platform === "win32" ? "windows" : "macos"),
      sourceKind: "window",
      target: {
        processId: target.processId,
        nativeWindowId: target.nativeWindowId,
      },
      authorization: {
        grantId: `cua_driver_${input.request.toolCallId}`,
        expiresAt,
      },
    });

    return this.publishActiveStatus("running", {
      target: {
        kind: "window",
        displayName: target.displayName,
        applicationId: target.applicationId,
      },
      preview: {
        descriptorId: this.descriptorId,
        revision: this.descriptorRevision,
        aspectRatio: target.aspectRatio,
        cursorAvailable: false,
      },
      updatedAt,
    });
  }

  finish(status: Extract<ComputerUseRuntimeStatus, "succeeded" | "failed" | "cancelled">, message?: string): void {
    const current = this.options.registry.get(this.options.cwd, this.sessionId);
    if (!current) {
      return;
    }
    const terminalAt = this.nextUpdatedAt();
    this.options.registry.upsert(this.options.cwd, {
      ...current,
      status,
      approvalRequired: undefined,
      failure: status === "failed"
        ? {
            code: "computer_use_run_failed",
            message: message?.trim() || "Computer Use run failed.",
            recoverable: false,
          }
        : undefined,
      updatedAt: terminalAt,
      terminalAt,
    });
    if (current.preview) {
      this.options.registry.revokePrivateDescriptor(this.options.cwd, current.preview.descriptorId);
    }
  }

  private publishActiveStatus(
    status: ActiveComputerUseRuntimeStatus,
    input: {
      readonly target?: ComputerUsePreviewProjection["target"];
      readonly preview?: ComputerUsePreviewProjection["preview"];
      readonly approvalRequired?: ComputerUsePreviewProjection["approvalRequired"];
      readonly updatedAt?: string;
    } = {},
  ): ComputerUsePreviewProjection {
    const current = this.currentProjection();
    const target = input.target ?? current?.target ?? {
      kind: "application" as const,
      displayName: "Computer Use",
    };
    const preview = input.preview ?? current?.preview;
    const approvalRequired = status === "waiting_for_approval" ? input.approvalRequired : undefined;
    if (
      current
      && current.status === status
      && current.target.kind === target.kind
      && current.target.displayName === target.displayName
      && current.target.applicationId === target.applicationId
      && current.preview?.descriptorId === preview?.descriptorId
      && current.preview?.revision === preview?.revision
      && current.preview?.aspectRatio === preview?.aspectRatio
      && current.approvalRequired?.approvalId === approvalRequired?.approvalId
      && current.approvalRequired?.summary === approvalRequired?.summary
    ) {
      return current;
    }
    return this.options.registry.upsert(this.options.cwd, {
      ...(current ?? {
        sessionId: this.sessionId,
        conversationId: this.options.conversationId,
        turnId: this.options.turnId,
        runId: this.options.runId,
        workUnitId: this.options.workUnitId,
        startedAt: this.options.startedAt,
      }),
      status,
      target,
      preview,
      approvalRequired,
      failure: undefined,
      updatedAt: input.updatedAt ?? this.nextUpdatedAt(),
      terminalAt: undefined,
    });
  }

  private currentProjection(): ComputerUsePreviewProjection | undefined {
    return this.options.registry.get(this.options.cwd, this.sessionId);
  }

  private isEligibleProviderDefinition(
    definition: Pick<PiRunnerMcpToolDefinition, "serverId">,
  ): boolean {
    return this.eligibleServerIds.has(definition.serverId);
  }

  private nextUpdatedAt(): string {
    const currentTime = Date.parse(this.currentProjection()?.updatedAt ?? "");
    const now = this.now().getTime();
    return new Date(Number.isFinite(currentTime) ? Math.max(now, currentTime + 1) : now).toISOString();
  }
}

function extractCaptureTarget(
  rawInput: unknown,
  result: PiRunnerMcpToolCallResult,
  current: CuaDriverCaptureTarget | undefined,
): CuaDriverCaptureTarget | undefined {
  const input = isRecord(rawInput) ? rawInput : {};
  const inputWindowId = readOptionalWindowId(input, "window_id");
  const inputProcessId = readOptionalPositiveInteger(input, "pid");
  if (inputWindowId === INVALID_OPTIONAL || inputProcessId === INVALID_OPTIONAL) {
    return undefined;
  }
  const candidates = structuredResultCandidates(result);
  const catalogs = candidates
    .filter((candidate) => Array.isArray(candidate.windows))
    .map((candidate) => ({
      candidate,
      windows: (candidate.windows as readonly unknown[]).filter(isRecord),
    }));
  if (catalogs.length > 0) {
    return extractCatalogCaptureTarget(
      catalogs,
      inputWindowId,
      inputProcessId,
      current,
    );
  }

  for (const candidate of candidates) {
    const candidateWindowId = readOptionalWindowId(candidate, "window_id");
    const candidateProcessId = readOptionalPositiveInteger(candidate, "pid");
    if (
      candidateWindowId === INVALID_OPTIONAL
      || candidateProcessId === INVALID_OPTIONAL
    ) {
      return undefined;
    }
    const nativeWindowId = candidateWindowId ??
      inputWindowId ??
      current?.nativeWindowId;
    if (!nativeWindowId) {
      continue;
    }
    const explicitProcessId = candidateProcessId ??
      inputProcessId;
    const processId = explicitProcessId
      ?? (nativeWindowId === current?.nativeWindowId ? current.processId : undefined);
    if (!processId) {
      continue;
    }
    const displayName = readNonEmptyString(candidate.title) ??
      readNonEmptyString(candidate.name) ??
      current?.displayName ??
      "Computer Use";
    const bounds = isRecord(candidate.bounds) ? candidate.bounds : undefined;
    return {
      processId,
      nativeWindowId,
      displayName,
      applicationId: readNonEmptyString(candidate.bundle_id) ?? current?.applicationId,
      aspectRatio: readAspectRatio(bounds) ?? current?.aspectRatio,
    };
  }

  if (!inputWindowId && !current?.nativeWindowId) {
    return undefined;
  }
  const nativeWindowId = inputWindowId ?? current?.nativeWindowId as string;
  const processId = inputProcessId
    ?? (nativeWindowId === current?.nativeWindowId ? current.processId : undefined);
  if (!processId) {
    return undefined;
  }
  return {
    processId,
    nativeWindowId,
    displayName: current?.displayName ?? "Computer Use",
    applicationId: current?.applicationId,
    aspectRatio: current?.aspectRatio,
  };
}

function extractCatalogCaptureTarget(
  catalogs: readonly {
    readonly candidate: Record<string, unknown>;
    readonly windows: readonly Record<string, unknown>[];
  }[],
  inputWindowId: string | undefined,
  inputProcessId: number | undefined,
  current: CuaDriverCaptureTarget | undefined,
): CuaDriverCaptureTarget | undefined {
  const hasExplicitIdentity = inputWindowId !== undefined || inputProcessId !== undefined;
  const expectedWindowId = inputWindowId ?? (!hasExplicitIdentity ? current?.nativeWindowId : undefined);
  const expectedProcessId = inputProcessId ?? (!hasExplicitIdentity ? current?.processId : undefined);
  const matches = catalogs.flatMap(({ candidate, windows }) => windows.flatMap((window) => {
    const nativeWindowId = readOptionalWindowId(window, "window_id");
    const processId = readOptionalPositiveInteger(window, "pid");
    if (
      nativeWindowId === INVALID_OPTIONAL
      || processId === INVALID_OPTIONAL
      || nativeWindowId === undefined
      || processId === undefined
      || (expectedWindowId !== undefined && nativeWindowId !== expectedWindowId)
      || (expectedProcessId !== undefined && processId !== expectedProcessId)
    ) {
      return [];
    }
    return [{ candidate, window, nativeWindowId, processId }];
  }));
  const matchesByIdentity = new Map<string, (typeof matches)[number]>();
  for (const match of matches) {
    const identity = `${match.processId}:${match.nativeWindowId}`;
    if (!matchesByIdentity.has(identity)) {
      matchesByIdentity.set(identity, match);
    }
  }
  if (matchesByIdentity.size !== 1) {
    return undefined;
  }
  const [{ candidate, window, nativeWindowId, processId }] = matchesByIdentity.values();
  const displayName = readNonEmptyString(window.title) ??
    readNonEmptyString(candidate.title) ??
    readNonEmptyString(candidate.name) ??
    current?.displayName ??
    "Computer Use";
  const bounds = isRecord(window.bounds)
    ? window.bounds
    : isRecord(candidate.bounds) ? candidate.bounds : undefined;
  return {
    processId,
    nativeWindowId,
    displayName,
    applicationId: readNonEmptyString(candidate.bundle_id) ?? current?.applicationId,
    aspectRatio: readAspectRatio(bounds) ?? current?.aspectRatio,
  };
}

function structuredResultCandidates(result: PiRunnerMcpToolCallResult): readonly Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  appendStructuredCandidate(candidates, result.details);
  for (const content of result.content) {
    if (content.type !== "text" || typeof content.text !== "string") {
      continue;
    }
    try {
      appendStructuredCandidate(candidates, JSON.parse(content.text));
    } catch {
      // Only strict JSON tool output is eligible for native target extraction.
    }
  }
  return candidates;
}

function appendStructuredCandidate(candidates: Record<string, unknown>[], value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  candidates.push(value);
  for (const key of ["result", "data", "structuredContent"] as const) {
    if (isRecord(value[key])) {
      candidates.push(value[key]);
    }
  }
}

function readAspectRatio(bounds: Record<string, unknown> | undefined): number | undefined {
  const width = readPositiveNumber(bounds?.width);
  const height = readPositiveNumber(bounds?.height);
  return width && height ? width / height : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readWindowId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return readNonEmptyString(value);
}

const INVALID_OPTIONAL = Symbol("invalid_optional");

function readOptionalWindowId(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined | typeof INVALID_OPTIONAL {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  return readWindowId(record[key]) ?? INVALID_OPTIONAL;
}

function readOptionalPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined | typeof INVALID_OPTIONAL {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  return readPositiveInteger(record[key]) ?? INVALID_OPTIONAL;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function targetKey(target: CuaDriverCaptureTarget): string {
  return `${target.processId}:${target.nativeWindowId}`;
}

function isTerminalProjection(projection: ComputerUsePreviewProjection): boolean {
  return projection.status === "succeeded" || projection.status === "failed" || projection.status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
