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

const CUA_DRIVER_SERVER_IDS = new Set(["mcp_cua_driver", "mcp:cua-driver"]);
const DESCRIPTOR_GRANT_TTL_MS = 15 * 60 * 1_000;

type ActiveComputerUseRuntimeStatus = Extract<
  ComputerUseRuntimeStatus,
  "starting" | "running" | "waiting_for_approval" | "paused"
>;

interface CuaDriverCaptureTarget {
  readonly processId?: number;
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
  readonly platform?: "macos" | "windows";
  readonly now?: () => Date;
  readonly createDescriptorId?: () => string;
}

export class CuaDriverComputerUseProjectionProducer {
  private readonly now: () => Date;
  private readonly createDescriptorId: () => string;
  private readonly sessionId: string;
  private descriptorId: string | undefined;
  private descriptorRevision = 0;
  private currentTarget: CuaDriverCaptureTarget | undefined;
  private readonly cuaToolCallIds = new Set<string>();
  private readonly cuaApprovalIds = new Set<string>();

  constructor(private readonly options: CuaDriverComputerUseProjectionProducerOptions) {
    this.now = options.now ?? (() => new Date());
    this.createDescriptorId = options.createDescriptorId ?? (() => `computer_use_descriptor_${randomUUID()}`);
    this.sessionId = `computer_use_${options.runId}`;
  }

  beginProviderIntent(input: {
    readonly request: Pick<PiRunnerMcpToolCallRequest, "toolCallId">;
    readonly definition: PiRunnerMcpToolDefinition;
  }): ComputerUsePreviewProjection | undefined {
    if (!isCuaDriverDefinition(input.definition)) {
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
      !isCuaDriverDefinition(input.definition) ||
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
      ...(status === "failed"
        ? {
            failure: {
              code: "computer_use_run_failed",
              message: message?.trim() || "Computer Use run failed.",
              recoverable: false,
            },
          }
        : {}),
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
  let explicitWindowCatalogMismatch = false;
  for (const candidate of structuredResultCandidates(result)) {
    const windows = Array.isArray(candidate.windows) ? candidate.windows.filter(isRecord) : [];
    const selectedWindow = selectWindow(windows, inputWindowId);
    if (inputWindowId && windows.length > 0 && !selectedWindow) {
      explicitWindowCatalogMismatch = true;
      continue;
    }
    const selectedWindowId = selectedWindow
      ? readOptionalWindowId(selectedWindow, "window_id")
      : undefined;
    const candidateWindowId = readOptionalWindowId(candidate, "window_id");
    const selectedProcessId = selectedWindow
      ? readOptionalPositiveInteger(selectedWindow, "pid")
      : undefined;
    const candidateProcessId = readOptionalPositiveInteger(candidate, "pid");
    if (
      selectedWindowId === INVALID_OPTIONAL
      || candidateWindowId === INVALID_OPTIONAL
      || selectedProcessId === INVALID_OPTIONAL
      || candidateProcessId === INVALID_OPTIONAL
    ) {
      return undefined;
    }
    if (
      selectedWindow
      && !inputWindowId
      && !current
      && !candidateWindowId
      && !candidateProcessId
      && !readNonEmptyString(candidate.bundle_id)
      && !readNonEmptyString(candidate.name)
    ) {
      continue;
    }
    const nativeWindowId = selectedWindowId ??
      candidateWindowId ??
      inputWindowId ??
      current?.nativeWindowId;
    if (!nativeWindowId) {
      continue;
    }
    const processId = selectedProcessId ??
      candidateProcessId ??
      inputProcessId ??
      current?.processId;
    const displayName = readNonEmptyString(selectedWindow?.title) ??
      readNonEmptyString(candidate.title) ??
      readNonEmptyString(candidate.name) ??
      current?.displayName ??
      "Computer Use";
    const bounds = isRecord(selectedWindow?.bounds)
      ? selectedWindow.bounds
      : isRecord(candidate.bounds) ? candidate.bounds : undefined;
    return {
      processId,
      nativeWindowId,
      displayName,
      applicationId: readNonEmptyString(candidate.bundle_id) ?? current?.applicationId,
      aspectRatio: readAspectRatio(bounds) ?? current?.aspectRatio,
    };
  }

  if (explicitWindowCatalogMismatch || (!inputWindowId && !current?.nativeWindowId)) {
    return undefined;
  }
  return {
    processId: inputProcessId ?? current?.processId,
    nativeWindowId: inputWindowId ?? current?.nativeWindowId as string,
    displayName: current?.displayName ?? "Computer Use",
    applicationId: current?.applicationId,
    aspectRatio: current?.aspectRatio,
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

function selectWindow(
  windows: readonly Record<string, unknown>[],
  requestedWindowId: string | undefined,
): Record<string, unknown> | undefined {
  if (requestedWindowId) {
    return windows.find((window) => readWindowId(window.window_id) === requestedWindowId);
  }
  // A result with exactly one window is unambiguous. Never choose among multiple
  // windows using z-order, current Space, visibility, or title heuristics.
  return windows.length === 1 ? windows[0] : undefined;
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
  return `${target.processId ?? ""}:${target.nativeWindowId}`;
}

function isCuaDriverDefinition(definition: Pick<PiRunnerMcpToolDefinition, "serverId">): boolean {
  return CUA_DRIVER_SERVER_IDS.has(definition.serverId);
}

function isTerminalProjection(projection: ComputerUsePreviewProjection): boolean {
  return projection.status === "succeeded" || projection.status === "failed" || projection.status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
