import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  defaultApprovalToolDecisions,
  riskyRunTools,
  syncExternalWorkActionForApproval,
  type ApprovalPayload,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalToolDecision,
  type CreateApprovalRequestInput,
  type RunEventEnvelope,
  type RunEventType,
  type RunSession,
  type RunStore,
  type RunTool,
  type SkillApprovalProfile,
} from "@ling-stack/core";
import type { PiRunnerApprovalRequest, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_PREVIEW_LIMIT = 1_200;

export function appendApprovalDecisionEvent(store: RunStore, approval: ApprovalRequest): void {
  if (!approval.runId) {
    return;
  }
  const run = store.getRun(approval.runId);
  if (!run) {
    return;
  }
  store.appendEvent(approval.runId, approvalDecisionEventType(approval), {
    approvalId: approval.id,
    status: approval.status,
    resolvedBy: approval.resolvedBy,
    decisionReason: approval.decisionReason,
  });
}

export function expireStalePendingApprovals(
  store: RunStore,
  options: { readonly runId?: string; readonly mediaJobId?: string; readonly externalWorkActionId?: string } = {},
): void {
  const now = new Date().toISOString();
  let safety = 0;
  for (;;) {
    const pending = store.listApprovalRequests({
      status: "pending",
      runId: options.runId,
      mediaJobId: options.mediaJobId,
      externalWorkActionId: options.externalWorkActionId,
      limit: 500,
    });
    const expired = pending.filter((approval) => approval.expiresAt && approval.expiresAt <= now);
    if (expired.length === 0) {
      return;
    }
    for (const approval of expired) {
      expireApproval(store, approval, now);
    }
    safety += 1;
    if (pending.length < 500 || safety > 20) {
      return;
    }
  }
}

export function expireStaleApproval(store: RunStore, approvalId: string): void {
  const approval = store.getApprovalRequest(approvalId);
  const now = new Date().toISOString();
  if (!approval || approval.status !== "pending" || !approval.expiresAt || approval.expiresAt > now) {
    return;
  }
  expireApproval(store, approval, now);
}

export function createRunApprovalHandler(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly approvalPolicy: ApprovalPolicy;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly signal?: AbortSignal;
}): PiRunnerRunOptions["onApprovalRequired"] {
  return async (request: PiRunnerApprovalRequest) => {
    const approvalInput = toCreateApprovalRequestInput(options.run, request);
    const policyDecision = evaluateApprovalPolicy(options.approvalPolicy, request, approvalInput.payload);
    if (policyDecision.decision === "allow") {
      return {
        approved: true,
        reason: policyDecision.reason,
      };
    }

    if (policyDecision.decision === "deny") {
      const denied = options.store.createApprovalRequest(approvalInput, new Date().toISOString());
      const resolved = options.store.denyApprovalRequest(
        denied.id,
        { reason: policyDecision.reason },
        new Date().toISOString(),
      );
      if (!resolved) {
        throw new Error(`Approval request not found after policy denial: ${denied.id}`);
      }
      const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(resolved));
      streamOrAppendApprovalDecisionEvent({
        store: options.store,
        approval: resolved,
        afterSeq: requestEvent?.seq ?? 0,
        appendAndMaybeStream: options.appendAndMaybeStream,
        streamEnvelope: options.streamEnvelope,
      });
      return {
        approved: false,
        approvalId: resolved.id,
        reason: resolved.decisionReason,
      };
    }

    const approval = options.store.createApprovalRequest(approvalInput, new Date().toISOString());
    const waitingAt = new Date().toISOString();
    options.store.transitionRunStatus({
      runId: options.run.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now: waitingAt,
    });
    const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(approval));

    const resolvedApproval = await waitForApprovalDecision(options.store, approval.id, options.signal);
    const resolvedAt = new Date().toISOString();
    if (resolvedApproval.status === "approved") {
      options.store.transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_approved",
        actor: "local-user",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
      });
    } else if (resolvedApproval.status === "expired") {
      options.store.transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_expired",
        actor: "system",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
        endedAt: resolvedAt,
        errorMessage: resolvedApproval.decisionReason ?? "Approval expired.",
      });
    } else {
      options.store.transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_denied",
        actor: "local-user",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
        endedAt: resolvedAt,
        errorMessage: resolvedApproval.decisionReason ?? "Approval denied.",
      });
    }
    streamOrAppendApprovalDecisionEvent({
      store: options.store,
      approval: resolvedApproval,
      afterSeq: requestEvent?.seq ?? 0,
      appendAndMaybeStream: options.appendAndMaybeStream,
      streamEnvelope: options.streamEnvelope,
    });

    if (resolvedApproval.status === "approved") {
      return {
        approved: true,
        approvalId: resolvedApproval.id,
        reason: resolvedApproval.decisionReason,
      };
    }

    return {
      approved: false,
      approvalId: resolvedApproval.id,
      reason:
        resolvedApproval.decisionReason ??
        `Ling Stack approval ${resolvedApproval.status} for ${resolvedApproval.actionType}.`,
    };
  };
}

export function mergeApprovalPolicyWithProfile(policy: ApprovalPolicy, profile: SkillApprovalProfile | undefined): ApprovalPolicy {
  if (!profile || profile.mode === "none") {
    return policy;
  }

  const requiredTools = new Set<RunTool>();
  for (const tool of profile.requiredForTools ?? []) {
    requiredTools.add(tool);
  }
  for (const action of profile.requiredForActions ?? []) {
    if (isRunTool(action)) {
      requiredTools.add(action);
    }
  }
  if (profile.mode === "strict") {
    for (const tool of riskyRunTools) {
      requiredTools.add(tool);
    }
  }
  if (requiredTools.size === 0) {
    return policy;
  }

  const toolDecisions = { ...policy.toolDecisions };
  for (const tool of requiredTools) {
    if (toolDecisions[tool] !== "deny") {
      toolDecisions[tool] = "ask";
    }
  }
  return { ...policy, toolDecisions };
}

export function mergeRunTools(base: readonly RunTool[], required: readonly RunTool[]): RunTool[] {
  const tools = new Set<RunTool>(base);
  for (const tool of required) {
    tools.add(tool);
  }
  return [...tools];
}

export function mergeApprovalProfiles(
  base: SkillApprovalProfile | undefined,
  required: SkillApprovalProfile,
): SkillApprovalProfile {
  if (!base || approvalModeRank(required.mode) > approvalModeRank(base.mode)) {
    return {
      ...required,
      requiredForTools: mergeRunTools(base?.requiredForTools ?? [], required.requiredForTools ?? []),
      requiredForActions: mergeStringList(base?.requiredForActions ?? [], required.requiredForActions ?? []),
    };
  }
  return {
    ...base,
    requiredForTools: mergeRunTools(base.requiredForTools ?? [], required.requiredForTools ?? []),
    requiredForActions: mergeStringList(base.requiredForActions ?? [], required.requiredForActions ?? []),
  };
}

export function usesSideEffectTools(tools: readonly RunTool[]): boolean {
  return tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write");
}

export function isRunTool(value: unknown): value is RunTool {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

function expireApproval(store: RunStore, approval: ApprovalRequest, now: string): ApprovalRequest | undefined {
  const expired = store.expireApprovalRequest(
    approval.id,
    { reason: "Approval request expired before a decision was received." },
    now,
  );
  if (expired) {
    appendApprovalDecisionEvent(store, expired);
    syncExternalWorkActionForApproval(store, expired, now);
  }
  return expired;
}

function approvalDecisionEventType(approval: ApprovalRequest): Extract<RunEventType, "approval_approved" | "approval_denied" | "approval_expired"> {
  if (approval.status === "approved") {
    return "approval_approved";
  }
  if (approval.status === "expired") {
    return "approval_expired";
  }
  return "approval_denied";
}

function approvalRequestEventPayload(approval: ApprovalRequest): Record<string, unknown> {
  return {
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    risk: approval.risk,
    title: approval.title,
    description: approval.description,
    payload: approval.payload,
    expiresAt: approval.expiresAt,
  };
}

function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  request: PiRunnerApprovalRequest,
  payload: ApprovalPayload,
): { readonly decision: ApprovalToolDecision; readonly reason: string } {
  const toolDecision = isRunTool(request.toolName)
    ? policy.toolDecisions[request.toolName] ?? defaultApprovalToolDecisions[request.toolName]
    : request.defaultApproval ?? "ask";
  if (toolDecision === "deny") {
    return {
      decision: "deny",
      reason: `Ling Stack policy denied ${request.toolName}.`,
    };
  }

  if ((payload.type === "file_write" || payload.type === "file_edit") && !isPathWithinAllowedWritePaths(payload.path, request.cwd, policy.allowedWritePaths)) {
    return {
      decision: "deny",
      reason: `Ling Stack policy denied ${request.toolName}: ${payload.path} is outside allowed write paths.`,
    };
  }

  if (toolDecision === "allow") {
    return {
      decision: "allow",
      reason: `Ling Stack policy allowed ${request.toolName}.`,
    };
  }

  return {
    decision: "ask",
    reason: `Ling Stack policy requires approval for ${request.toolName}.`,
  };
}

function mergeStringList<T extends string>(base: readonly T[], required: readonly T[]): T[] {
  return [...new Set([...base, ...required])];
}

function approvalModeRank(mode: SkillApprovalProfile["mode"]): number {
  if (mode === "strict") {
    return 2;
  }
  if (mode === "standard") {
    return 1;
  }
  return 0;
}

function toCreateApprovalRequestInput(run: RunSession, request: PiRunnerApprovalRequest): CreateApprovalRequestInput {
  const payload = toApprovalPayload(request);
  const risk = classifyApprovalRisk(request, payload);
  return {
    runId: run.id,
    taskId: run.taskId,
    channelId: run.channelId,
    toolCallId: request.toolCallId,
    actionType: isRunTool(request.toolName) ? request.toolName : "mcp_tool_call",
    risk,
    title: approvalTitle(request.toolName, risk),
    description: approvalDescription(request.toolName, payload),
    payload,
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function toApprovalPayload(request: PiRunnerApprovalRequest): ApprovalPayload {
  if (request.toolName === "bash") {
    const command = readInputString(request.input, "command", "");
    return {
      type: "bash",
      cwd: request.cwd,
      command,
      riskFlags: classifyBashRiskFlags(command),
    };
  }

  if (request.toolName === "write") {
    const path = readInputString(request.input, "path", "<unknown>");
    const content = readInputString(request.input, "content", "");
    return {
      type: "file_write",
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      preview: truncatePreview(content),
    };
  }

  if (!isRunTool(request.toolName)) {
    return {
      type: "mcp_tool_call",
      toolName: request.toolName,
      cwd: request.cwd,
      input: request.input,
    };
  }

  if (
    request.toolName === "read" ||
    request.toolName === "grep" ||
    request.toolName === "find" ||
    request.toolName === "ls"
  ) {
    return {
      type: "tool_call",
      toolName: request.toolName,
      cwd: request.cwd,
      input: request.input,
    };
  }

  const path = readInputString(request.input, "path", "<unknown>");
  return {
    type: "file_edit",
    path,
    diffPreview: truncatePreview(formatEditPreview(readInputArray(request.input, "edits"))),
  };
}

function classifyApprovalRisk(request: PiRunnerApprovalRequest, payload: ApprovalPayload): ApprovalRisk {
  if (payload.type === "bash") {
    return payload.riskFlags.length > 0 ? "high" : "medium";
  }

  if (payload.type === "file_write" && isOutsideWorkspace(payload.path, request.cwd)) {
    return "high";
  }

  if (payload.type === "file_edit" && isOutsideWorkspace(payload.path, request.cwd)) {
    return "high";
  }

  if (payload.type === "tool_call") {
    return "low";
  }

  if (payload.type === "mcp_tool_call") {
    return "medium";
  }

  return "medium";
}

function approvalTitle(toolName: PiRunnerApprovalRequest["toolName"], risk: ApprovalRisk): string {
  if (toolName === "bash") {
    return risk === "high" ? "Approve high-risk shell command" : "Approve shell command";
  }
  if (toolName === "write") {
    return "Approve file write";
  }
  if (toolName === "edit") {
    return "Approve file edit";
  }
  if (!isRunTool(toolName)) {
    return "Approve MCP tool call";
  }
  return `Approve ${toolName}`;
}

function approvalDescription(toolName: PiRunnerApprovalRequest["toolName"], payload: ApprovalPayload): string {
  if (payload.type === "bash") {
    return payload.command || "The agent requested a shell command.";
  }
  if (payload.type === "file_write") {
    return `The agent requested writing ${payload.bytes} bytes to ${payload.path}.`;
  }
  if (payload.type === "file_edit") {
    return `The agent requested editing ${payload.path}.`;
  }
  if (payload.type === "tool_call") {
    return `The agent requested ${payload.toolName}.`;
  }
  if (payload.type === "mcp_tool_call") {
    return `The agent requested MCP tool ${payload.toolName}.`;
  }
  return `The agent requested ${toolName}.`;
}

async function waitForApprovalDecision(store: RunStore, approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const approval = store.getApprovalRequest(approvalId);
    if (!approval) {
      throw new Error(`Approval request not found: ${approvalId}`);
    }
    if (approval.status !== "pending") {
      return approval;
    }
    await delay(APPROVAL_POLL_INTERVAL_MS);
  }

  const expired = store.expireApprovalRequest(
    approvalId,
    { reason: "Approval request timed out before a decision was received." },
    new Date().toISOString(),
  );
  if (!expired) {
    throw new Error(`Approval request not found after timeout: ${approvalId}`);
  }
  appendApprovalDecisionEvent(store, expired);
  return expired;
}

function streamOrAppendApprovalDecisionEvent(options: {
  readonly store: RunStore;
  readonly approval: ApprovalRequest;
  readonly afterSeq: number;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}): void {
  const existingEvent = findApprovalDecisionEvent(options.store, options.approval, options.afterSeq);
  if (existingEvent) {
    options.streamEnvelope(existingEvent);
    return;
  }

  options.appendAndMaybeStream(approvalDecisionEventType(options.approval), {
    approvalId: options.approval.id,
    status: options.approval.status,
    resolvedBy: options.approval.resolvedBy,
    decisionReason: options.approval.decisionReason,
  });
}

function findApprovalDecisionEvent(
  store: RunStore,
  approval: ApprovalRequest,
  afterSeq: number,
): RunEventEnvelope | undefined {
  if (!approval.runId) {
    return undefined;
  }
  return store
    .listEvents(approval.runId, { afterSeq, limit: 1000 })
    .find(
      (event) =>
        (event.type === "approval_approved" || event.type === "approval_denied" || event.type === "approval_expired") &&
        isRecord(event.data) &&
        event.data.approvalId === approval.id,
    );
}

function classifyBashRiskFlags(command: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+-(?:[^\n]*r[^\n]*f|[^\n]*f[^\n]*r)\b/i, "destructive_remove"],
    [/\bgit\s+reset\s+--hard\b/i, "git_reset_hard"],
    [/\bgit\s+push\b[^\n]*--force\b/i, "git_force_push"],
    [/\bsudo\b/i, "sudo"],
    [/\b(?:chmod|chown)\s+-R\b/i, "recursive_permission_change"],
    [/\b(?:dd|mkfs|diskutil)\b/i, "disk_mutation"],
    [/\b(?:kubectl|helm|flyctl|vercel|netlify|aws|gcloud|az)\b[^\n]*\b(?:apply|delete|deploy|destroy|terminate)\b/i, "external_mutation"],
    [/\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sh|bash)\b/i, "remote_script_execution"],
  ];
  return checks.filter(([pattern]) => pattern.test(command)).map(([, flag]) => flag);
}

function isOutsideWorkspace(inputPath: string, cwd: string): boolean {
  if (inputPath === "<unknown>") {
    return true;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  const relativePath = relative(cwd, absolutePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}

function isPathWithinAllowedWritePaths(inputPath: string, cwd: string, allowedWritePaths: readonly string[]): boolean {
  if (inputPath === "<unknown>") {
    return false;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  return allowedWritePaths.some((allowedPath) => {
    const scopePath = isAbsolute(allowedPath) ? allowedPath : resolvePath(cwd, allowedPath);
    const relativePath = relative(scopePath, absolutePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

function formatEditPreview(edits: readonly unknown[]): string {
  if (edits.length === 0) {
    return "No edit preview was provided.";
  }
  return edits
    .map((edit, index) => {
      if (!isRecord(edit)) {
        return `#${index + 1}\n<invalid edit entry>`;
      }
      const oldText = readInputString(edit, "oldText", "");
      const newText = readInputString(edit, "newText", "");
      return `#${index + 1}\n- ${truncatePreview(oldText, 320)}\n+ ${truncatePreview(newText, 320)}`;
    })
    .join("\n\n");
}

function readInputString(input: unknown, key: string, fallback: string): string {
  if (!isRecord(input)) {
    return fallback;
  }
  const value = input[key];
  return typeof value === "string" ? value : fallback;
}

function readInputArray(input: unknown, key: string): unknown[] {
  if (!isRecord(input)) {
    return [];
  }
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function truncatePreview(value: string, limit = APPROVAL_PREVIEW_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}
