import { execFileSync } from "node:child_process";
import type {
  ApprovalActionType,
  ApprovalPayload,
  ApprovalRequest,
  ApprovalRisk,
  ExecutionActionTargetRef,
  ExecutionScope,
  RunEventEnvelope,
  RunSession,
} from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { readOnlyToolInput } from "./execution-action-tool-evidence.js";
import { classifyHostCapabilityAction, classifyHostCapabilityToolAction } from "./host-capability-action.js";

export interface ClassifiedAction {
  readonly actionType: ApprovalActionType;
  readonly risk: ApprovalRisk;
  readonly scopes: readonly ExecutionScope[];
  readonly scopeSummary: string;
  readonly title: string;
  readonly summary: string;
  readonly targetRefs: readonly ExecutionActionTargetRef[];
}

export interface GitCommandPreview {
  readonly kind: "git_commit" | "git_push" | "unknown";
  readonly previewStatus: "ready" | "unavailable";
  readonly failClosed: boolean;
  readonly rawCommand: string;
  readonly reason?: string;
  readonly currentBranch?: string;
  readonly stagedPaths?: readonly string[];
  readonly stagedDiffStat?: string;
  readonly commitMessage?: string;
  readonly remote?: string;
  readonly remoteBranch?: string;
  readonly upstream?: string;
  readonly aheadCount?: number;
  readonly behindCount?: number;
  readonly commitsToPush?: readonly string[];
  readonly protectedBranchWarning?: string;
  readonly forcePush?: boolean;
}

export function classifyApprovalAction(approval: ApprovalRequest, run: RunSession | undefined): ClassifiedAction {
  const base = classifyPayloadAction(approval.payload, run?.cwd);
  return {
    ...base,
    actionType: approval.actionType,
    risk: maxRisk(base.risk, approval.risk),
    title: approval.title,
    summary: approval.description,
    targetRefs: mergeTargetRefs(base.targetRefs, buildCommonRefs(run, approval.actionType === "host_capability" ? undefined : approval.toolCallId)),
  };
}

export function classifyToolAction(input: {
  readonly run: RunSession;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}): ClassifiedAction {
  const host = classifyHostCapabilityToolAction({ toolName: input.toolName, input: input.args, cwd: input.run.cwd });
  if (host) {
    return { ...host, targetRefs: mergeTargetRefs(host.targetRefs, buildCommonRefs(input.run)) };
  }
  if (input.toolName === "bash") {
    const command = readInputString(input.args, "command", "");
    const riskFlags = classifyBashRiskFlags(command);
    const payload: ApprovalPayload = {
      type: "bash",
      cwd: input.run.cwd,
      command,
      riskFlags,
    };
    const classified = classifyPayloadAction(payload, input.run.cwd);
    return {
      ...classified,
      risk: classified.actionType === "bash" && riskFlags.length === 0 ? "low" : classified.risk,
      targetRefs: mergeTargetRefs(classified.targetRefs, buildCommonRefs(input.run, input.toolCallId)),
    };
  }

  if (input.toolName === "write") {
    const path = readInputString(input.args, "path", "");
    const touchedPaths = readToolResultTouchedPaths(input.result);
    const content = readInputString(input.args, "content", "");
    const classified = classifyPayloadAction({
      type: "file_write",
      path,
      ...(touchedPaths.length > 0 ? { touchedPaths } : {}),
      bytes: Buffer.byteLength(content, "utf8"),
      preview: truncate(content, 160),
    }, input.run.cwd);
    return {
      ...classified,
      targetRefs: mergeTargetRefs(
        touchedPaths.length > 0 || isUsableToolFilePath(path) ? classified.targetRefs : [],
        buildCommonRefs(input.run, input.toolCallId),
      ),
    };
  }

  if (input.toolName === "edit") {
    const path = readInputString(input.args, "path", "");
    const touchedPaths = readToolResultTouchedPaths(input.result);
    const classified = classifyPayloadAction({
      type: "file_edit",
      path,
      diffPreview: "",
      ...(touchedPaths.length > 0 ? { touchedPaths } : {}),
    }, input.run.cwd);
    return {
      ...classified,
      targetRefs: mergeTargetRefs(
        touchedPaths.length > 0 || isUsableToolFilePath(path) ? classified.targetRefs : [],
        buildCommonRefs(input.run, input.toolCallId),
      ),
    };
  }

  if (isReadOnlyTool(input.toolName)) {
    const classified = classifyPayloadAction({
      type: "tool_call",
      toolName: input.toolName,
      cwd: input.run.cwd,
      input: input.args,
    }, input.run.cwd);
    return { ...classified, targetRefs: mergeTargetRefs(classified.targetRefs, buildCommonRefs(input.run, input.toolCallId)) };
  }

  const classified = classifyPayloadAction({
    type: "mcp_tool_call",
    toolName: input.toolName,
    cwd: input.run.cwd,
    input: input.args,
  }, input.run.cwd);
  return { ...classified, title: input.toolName, targetRefs: mergeTargetRefs(classified.targetRefs, buildCommonRefs(input.run, input.toolCallId)) };
}

export function classifyApprovalActionType(toolName: string, payload: ApprovalPayload): ApprovalActionType {
  if (payload.type === "host_capability") return "host_capability";
  if (payload.type === "bash") {
    return classifyBashActionType(payload.command);
  }
  if (payload.type === "file_write") {
    return "write";
  }
  if (payload.type === "file_edit") {
    return "edit";
  }
  if (payload.type === "tool_call") {
    return payload.toolName;
  }
  if (payload.type === "mcp_tool_call") {
    return "mcp_tool_call";
  }
  if (payload.type === "external_send" || payload.type === "external_action") {
    return "external_send";
  }
  if (payload.type === "deploy") {
    return "deploy";
  }
  if (payload.type === "media_cost") {
    return "media_cost";
  }
  if (payload.type === "provider_change") {
    return "provider_change";
  }
  return isApprovalActionType(toolName) ? toolName : "mcp_tool_call";
}

export function classifyBashActionType(command: string): ApprovalActionType {
  const tokens = tokenizeSimpleCommand(command);
  if (tokens[0] === "git" && tokens[1] === "commit") {
    return "git_commit";
  }
  if (tokens[0] === "git" && tokens[1] === "push") {
    return "git_push";
  }
  if (/\b(?:flyctl|vercel|netlify|kubectl|helm|aws|gcloud|az)\b/i.test(command)) {
    return "deploy";
  }
  return "bash";
}

export function classifyBashRiskFlags(command: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+-(?:[^\n]*r[^\n]*f|[^\n]*f[^\n]*r)\b/i, "destructive_remove"],
    [/\bgit\s+reset\s+--hard\b/i, "git_reset_hard"],
    [/\bgit\s+push\b[^\n]*--force(?:-with-lease)?\b/i, "git_force_push"],
    [/\bsudo\b/i, "sudo"],
    [/\b(?:chmod|chown)\s+-R\b/i, "recursive_permission_change"],
    [/\b(?:dd|mkfs|diskutil)\b/i, "disk_mutation"],
    [/\b(?:kubectl|helm|flyctl|vercel|netlify|aws|gcloud|az)\b[^\n]*\b(?:apply|delete|deploy|destroy|terminate)\b/i, "external_mutation"],
    [/\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sh|bash)\b/i, "remote_script_execution"],
  ];
  return checks.filter(([pattern]) => pattern.test(command)).map(([, flag]) => flag);
}

export function buildGitCommandPreview(cwd: string, rawCommand: string): GitCommandPreview | undefined {
  const kind = classifyBashActionType(rawCommand);
  if (kind !== "git_commit" && kind !== "git_push") {
    return undefined;
  }
  if (/[;&|`$<>]/.test(rawCommand.replace(/--force-with-lease/g, ""))) {
    return unavailableGitPreview(kind, rawCommand, "Compound or shell-expanded git command requires fail-closed review.");
  }
  const tokens = tokenizeSimpleCommand(rawCommand);
  if (tokens[0] !== "git") {
    return unavailableGitPreview(kind, rawCommand, "Command does not parse as a direct git invocation.");
  }
  try {
    return kind === "git_commit"
      ? buildGitCommitPreview(cwd, rawCommand, tokens)
      : buildGitPushPreview(cwd, rawCommand, tokens);
  } catch (error) {
    return unavailableGitPreview(kind, rawCommand, error instanceof Error ? error.message : String(error));
  }
}

export function artifactIdsForToolCall(events: readonly RunEventEnvelope[], toolCallId: string): string[] {
  return [...new Set(events
    .filter((event) => event.type === "artifact_created" && readEventString(event, "toolCallId") === toolCallId)
    .filter((event) => readEventString(event, "role") !== "preview")
    .map((event) => readEventString(event, "artifactId") ?? readNestedArtifactId(event))
    .filter((artifactId): artifactId is string => Boolean(artifactId)))];
}

function classifyPayloadAction(payload: ApprovalPayload, cwd = ""): ClassifiedAction {
  if (payload.type === "host_capability") return classifyHostCapabilityAction(payload);
  if (payload.type === "bash") {
    const actionType = classifyBashActionType(payload.command);
    const scopes = classifyCommandScopes(payload.command, actionType);
    const forcePush = /\bgit\s+push\b[^\n]*--force(?:-with-lease)?\b/i.test(payload.command);
    return {
      actionType,
      risk: forcePush ? "critical" : payload.riskFlags.length > 0 ? "high" : actionType === "git_push" ? "high" : "medium",
      scopes,
      scopeSummary: scopes.join(", "),
      title: actionType === "git_commit" ? "Git commit" : actionType === "git_push" ? "Git push" : "Shell command",
      summary: payload.command || "Shell command",
      targetRefs: [{ type: "command", label: truncate(payload.command, 120) }],
    };
  }
  if (payload.type === "file_write" || payload.type === "file_edit") {
    const paths = payload.touchedPaths && payload.touchedPaths.length > 0
      ? payload.touchedPaths
      : [payload.path];
    return {
      actionType: payload.type === "file_write" ? "write" : "edit",
      risk: "medium",
      scopes: ["workspace_write"],
      scopeSummary: "workspace_write",
      title: payload.type === "file_write" ? "File write" : "File edit",
      summary: paths.join(", "),
      targetRefs: paths
        .filter(isUsableToolFilePath)
        .map((path) => ({ type: "file", path, label: path })),
    };
  }
  if (payload.type === "tool_call") {
    const input = readOnlyToolInput(payload.toolName, payload.input, payload.cwd ?? cwd);
    return {
      actionType: payload.toolName,
      risk: "low",
      scopes: ["read_only"],
      scopeSummary: "read_only",
      title: payload.toolName,
      summary: input?.summary ?? payload.toolName,
      targetRefs: input?.path ? [{ type: "file", path: input.path, label: input.path }] : [],
    };
  }
  if (payload.type === "mcp_tool_call") {
    return {
      actionType: "mcp_tool_call",
      risk: "medium",
      scopes: ["external_system"],
      scopeSummary: "external_system",
      title: "MCP tool call",
      summary: payload.toolName,
      targetRefs: [{ type: "mcp_tool", label: payload.toolName }],
    };
  }
  if (payload.type === "provider_change") {
    return {
      actionType: "provider_change",
      risk: "high",
      scopes: ["provider_config", "credential"],
      scopeSummary: "provider_config, credential",
      title: "Provider change",
      summary: payload.providerPresetId,
      targetRefs: [],
    };
  }
  if (payload.type === "deploy") {
    return {
      actionType: "deploy",
      risk: "critical",
      scopes: ["deployment", "external_system"],
      scopeSummary: "deployment, external_system",
      title: "Deploy",
      summary: payload.command ?? payload.target,
      targetRefs: payload.command ? [{ type: "command", label: truncate(payload.command, 120) }] : [],
    };
  }
  if (payload.type === "external_send" || payload.type === "external_action") {
    return {
      actionType: "external_send",
      risk: "high",
      scopes: ["external_system", "network"],
      scopeSummary: "external_system, network",
      title: "External send",
      summary: payload.type === "external_send" ? payload.destination : payload.actionKind,
      targetRefs: [],
    };
  }
  if (payload.type === "media_cost") {
    return {
      actionType: "media_cost",
      risk: "medium",
      scopes: ["external_system", "network"],
      scopeSummary: "external_system, network",
      title: "Media cost",
      summary: payload.operation,
      targetRefs: [],
    };
  }
  return {
    actionType: "bash",
    risk: "medium",
    scopes: cwd ? ["workspace_write"] : ["external_system"],
    scopeSummary: cwd ? "workspace_write" : "external_system",
    title: "Action",
    summary: "Action",
    targetRefs: [],
  };
}

function classifyCommandScopes(command: string, actionType: ApprovalActionType): ExecutionScope[] {
  const scopes = new Set<ExecutionScope>();
  if (actionType === "git_commit" || actionType === "git_push" || /\bgit\s+(?:commit|push|tag|reset|rebase)\b/i.test(command)) {
    scopes.add("git_history");
  }
  if (/\b(?:curl|wget|ssh|scp|rsync|git\s+push)\b/i.test(command)) {
    scopes.add("network");
  }
  if (/\b(?:kubectl|helm|flyctl|vercel|netlify|aws|gcloud|az)\b/i.test(command)) {
    scopes.add("deployment");
    scopes.add("external_system");
  }
  if (/\b(?:export\s+\w*(?:KEY|TOKEN|SECRET)|security\s+|op\s+|pass\s+)\b/i.test(command)) {
    scopes.add("credential");
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:publish|login)\b/i.test(command)) {
    scopes.add("external_system");
    scopes.add("network");
  }
  if (scopes.size === 0) {
    scopes.add("workspace_write");
  }
  return [...scopes];
}

function buildGitCommitPreview(cwd: string, rawCommand: string, tokens: readonly string[]): GitCommandPreview {
  const commitMessage = readCommitMessage(tokens);
  return {
    kind: "git_commit",
    previewStatus: "ready",
    failClosed: false,
    rawCommand,
    currentBranch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    stagedPaths: git(cwd, ["diff", "--cached", "--name-only", "--"]).split(/\r?\n/).filter(Boolean),
    stagedDiffStat: git(cwd, ["diff", "--cached", "--stat", "--"]).trim(),
    commitMessage,
  };
}

function buildGitPushPreview(cwd: string, rawCommand: string, tokens: readonly string[]): GitCommandPreview {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const remote = firstNonFlag(tokens.slice(2)) ?? "origin";
  const remoteBranch = secondNonFlag(tokens.slice(2)) ?? branch;
  const upstream = resolveUpstream(cwd);
  const aheadBehind = upstream ? readAheadBehind(cwd, upstream) : { aheadCount: undefined, behindCount: undefined };
  const forcePush = tokens.some((token) => token === "--force" || token === "-f" || token === "--force-with-lease");
  return {
    kind: "git_push",
    previewStatus: "ready",
    failClosed: forcePush,
    rawCommand,
    currentBranch: branch,
    remote,
    remoteBranch,
    upstream,
    aheadCount: aheadBehind.aheadCount,
    behindCount: aheadBehind.behindCount,
    commitsToPush: upstream ? git(cwd, ["log", "--oneline", `${upstream}..HEAD`]).split(/\r?\n/).filter(Boolean) : [],
    protectedBranchWarning: remoteBranch === "main" || remoteBranch === "master" ? `Pushing to protected-looking branch ${remoteBranch}.` : undefined,
    forcePush,
  };
}

function unavailableGitPreview(kind: "git_commit" | "git_push", rawCommand: string, reason: string): GitCommandPreview {
  return { kind, previewStatus: "unavailable", failClosed: true, rawCommand, reason };
}

function readAheadBehind(cwd: string, upstream: string): { readonly aheadCount?: number; readonly behindCount?: number } {
  const output = git(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).trim();
  const [behind, ahead] = output.split(/\s+/).map((item) => Number.parseInt(item, 10));
  return { aheadCount: Number.isFinite(ahead) ? ahead : undefined, behindCount: Number.isFinite(behind) ? behind : undefined };
}

function resolveUpstream(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
  } catch {
    return undefined;
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024 });
}

function tokenizeSimpleCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function readCommitMessage(tokens: readonly string[]): string | undefined {
  const messageIndex = tokens.findIndex((token) => token === "-m" || token === "--message");
  if (messageIndex >= 0) {
    return tokens[messageIndex + 1];
  }
  const inline = tokens.find((token) => token.startsWith("--message="));
  return inline?.slice("--message=".length);
}

function firstNonFlag(tokens: readonly string[]): string | undefined {
  return tokens.find((token) => !token.startsWith("-"));
}

function secondNonFlag(tokens: readonly string[]): string | undefined {
  return tokens.filter((token) => !token.startsWith("-"))[1];
}

function buildCommonRefs(run: RunSession | undefined, toolCallId?: string): ExecutionActionTargetRef[] {
  const refs: ExecutionActionTargetRef[] = [];
  if (run) {
    refs.push({ type: "run", id: run.id });
    if (run.workUnitId) {
      refs.push({ type: "work_unit", id: run.workUnitId });
    }
    refs.push({ type: "task", id: run.taskId });
    if (run.channelId) {
      refs.push({ type: "channel", id: run.channelId });
    }
    if (run.workflowStepId) {
      refs.push({ type: "workflow_step", id: run.workflowStepId });
    }
  }
  if (toolCallId) {
    refs.push({ type: "mcp_tool", id: toolCallId, label: toolCallId });
  }
  return refs;
}

function mergeTargetRefs(left: readonly ExecutionActionTargetRef[], right: readonly ExecutionActionTargetRef[]): ExecutionActionTargetRef[] {
  const seen = new Set<string>();
  const merged: ExecutionActionTargetRef[] = [];
  for (const ref of [...right, ...left]) {
    const key = `${ref.type}:${ref.id ?? ""}:${ref.path ?? ""}:${ref.label ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

function maxRisk(left: ApprovalRisk, right: ApprovalRisk): ApprovalRisk {
  const rank: Record<ApprovalRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return rank[left] >= rank[right] ? left : right;
}

function isReadOnlyTool(value: string): value is "read" | "grep" | "find" | "ls" {
  return value === "read" || value === "grep" || value === "find" || value === "ls";
}

function isApprovalActionType(value: string): value is ApprovalActionType {
  return [
    "read",
    "grep",
    "find",
    "ls",
    "write",
    "edit",
    "bash",
    "git_commit",
    "git_push",
    "external_send",
    "deploy",
    "media_cost",
    "credential_change",
    "provider_change",
    "workflow_step",
    "mcp_tool_call",
  ].includes(value);
}

function readInputString(value: unknown, key: string, fallback: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : fallback;
}

function isUsableToolFilePath(value: string): boolean {
  const path = value.trim();
  return path.length > 0 && path !== "<unknown>";
}

function readToolResultTouchedPaths(value: unknown): readonly string[] {
  if (!isRecord(value) || !isRecord(value.details) || !Array.isArray(value.details.touchedPaths)) {
    return [];
  }
  return [...new Set(value.details.touchedPaths
    .filter((path): path is string => typeof path === "string")
    .map((path) => path.trim())
    .filter(isUsableToolFilePath))];
}

function readEventString(event: RunEventEnvelope, key: string): string | undefined {
  return isRecord(event.data) && typeof event.data[key] === "string" ? event.data[key] : undefined;
}

function readNestedArtifactId(event: RunEventEnvelope): string | undefined {
  if (!isRecord(event.data) || !isRecord(event.data.artifact)) {
    return undefined;
  }
  return typeof event.data.artifact.id === "string" ? event.data.artifact.id : undefined;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
