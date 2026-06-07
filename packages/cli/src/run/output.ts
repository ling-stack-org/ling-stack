import type { RunEventEnvelope } from "./events.js";

export interface RunOutputWriters {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface RunOutputOptions {
  readonly json: boolean;
  readonly verbose: boolean;
  readonly daemonUrl: string;
  readonly cwd: string;
  readonly writers: RunOutputWriters;
}

export interface RunOutput {
  handleReady(runId: string): void;
  handleEvent(envelope: RunEventEnvelope): void;
  finish(): void;
  exitCode(): number;
}

export function createRunOutput(options: RunOutputOptions): RunOutput {
  return new RunPrinter(options);
}

class RunPrinter implements RunOutput {
  private textOpen = false;
  private runFailed = false;
  private approvalDenied = false;

  constructor(private readonly options: RunOutputOptions) {}

  handleReady(runId: string): void {
    if (this.options.json) {
      this.stdoutLine(JSON.stringify({ type: "ready", runId }));
      return;
    }
    this.stderrLine(`Run: ${runId}`);
  }

  handleEvent(envelope: RunEventEnvelope): void {
    if (this.options.json) {
      this.stdoutLine(JSON.stringify(envelope));
      if (envelope.type === "approval_requested") {
        this.printApprovalRequested(envelope.data);
      }
      this.updateExitState(envelope);
      return;
    }

    switch (envelope.type) {
      case "run_created":
        if (this.options.verbose) {
          this.stderrLine(`Run created: ${envelope.runId}`);
        }
        break;
      case "run_start":
        this.printRunStart(envelope.data);
        break;
      case "assistant_text_delta":
        this.writeTextDelta(envelope.data);
        break;
      case "assistant_thinking_delta":
        if (this.options.verbose) {
          this.stderrLine(`[thinking] ${readString(envelope.data, "text") ?? summarizeUnknown(envelope.data, 180)}`);
        }
        break;
      case "message_end":
        this.closeText();
        break;
      case "tool_start":
        this.printToolStart(envelope.data);
        break;
      case "tool_update":
        if (this.options.verbose) {
          this.stderrLine(`Tool update: ${summarizeToolName(envelope.data)} ${summarizeUnknown(readField(envelope.data, "partialResult"), 180)}`);
        }
        break;
      case "tool_end":
        this.printToolEnd(envelope.data);
        break;
      case "approval_requested":
        this.printApprovalRequested(envelope.data);
        break;
      case "approval_approved":
        this.stderrLine(`Approval approved: ${readString(envelope.data, "approvalId") ?? "<unknown>"}`);
        break;
      case "approval_denied":
        this.stderrLine(`Approval denied: ${readString(envelope.data, "approvalId") ?? "<unknown>"}`);
        break;
      case "approval_expired":
        this.stderrLine(`Approval expired: ${readString(envelope.data, "approvalId") ?? "<unknown>"}`);
        break;
      case "run_error":
        this.stderrLine(`Run failed: ${readString(envelope.data, "message") ?? summarizeUnknown(envelope.data, 240)}`);
        break;
      case "run_end":
        this.stderrLine(`Run ended: ${readString(envelope.data, "taskId") ?? envelope.runId}`);
        break;
      case "result":
        this.stderrLine(`Result: ${summarizeResult(envelope.data)}`);
        break;
      default:
        if (this.options.verbose) {
          this.stderrLine(`${envelope.type}: ${summarizeUnknown(envelope.data, 240)}`);
        }
    }

    this.updateExitState(envelope);
  }

  finish(): void {
    this.closeText();
  }

  exitCode(): number {
    if (this.approvalDenied) {
      return 5;
    }
    if (this.runFailed) {
      return 6;
    }
    return 0;
  }

  private updateExitState(envelope: RunEventEnvelope): void {
    if (envelope.type === "run_error") {
      this.runFailed = true;
    }
    if (envelope.type === "approval_denied" || envelope.type === "approval_expired") {
      this.approvalDenied = true;
    }
  }

  private printRunStart(data: unknown): void {
    const provider = readString(data, "provider");
    const model = readString(data, "model");
    const cwd = readString(data, "cwd");
    const suffix = [provider, model].filter(Boolean).join("/");
    this.stderrLine(`Started${suffix ? `: ${suffix}` : ""}${cwd ? ` (${cwd})` : ""}`);
  }

  private writeTextDelta(data: unknown): void {
    const text = readString(data, "text");
    if (!text) {
      return;
    }
    this.options.writers.stdout.write(text);
    this.textOpen = true;
  }

  private printToolStart(data: unknown): void {
    const toolName = summarizeToolName(data);
    const args = readField(data, "args");
    this.stderrLine(`Tool start: ${toolName}${args === undefined ? "" : ` ${summarizeUnknown(args, 180)}`}`);
  }

  private printToolEnd(data: unknown): void {
    const toolName = summarizeToolName(data);
    const isError = readBoolean(data, "isError") ?? false;
    const result = readField(data, "result");
    const resultSummary = summarizeUnifiedExecResult(result) || summarizeUnknown(result, 180);
    this.stderrLine(`Tool end: ${toolName} ${isError ? "error" : "ok"}${resultSummary ? ` ${resultSummary}` : ""}`);
  }

  private printApprovalRequested(data: unknown): void {
    const approvalId = readString(data, "approvalId") ?? "<unknown>";
    const actionType = readString(data, "actionType") ?? "action";
    const risk = readString(data, "risk") ?? "unknown";
    const title = readString(data, "title") ?? "Approval requested";
    const description = readString(data, "description");
    const payload = readField(data, "payload");

    this.stderrLine("");
    this.stderrLine("Approval requested");
    this.stderrLine(`  ID: ${approvalId}`);
    this.stderrLine(`  Action: ${actionType}`);
    this.stderrLine(`  Risk: ${risk}`);
    this.stderrLine(`  Title: ${title}`);
    if (description) {
      this.stderrLine(`  Description: ${description}`);
    }
    const payloadSummary = summarizeApprovalPayload(payload);
    if (payloadSummary) {
      this.stderrLine(`  Payload: ${payloadSummary}`);
    }
    this.stderrLine("  Approve:");
    this.stderrLine(`    ling-stack --daemon-url ${shellQuote(this.options.daemonUrl)} --cwd ${shellQuote(this.options.cwd)} approvals approve ${shellQuote(approvalId)}`);
    this.stderrLine("  Deny:");
    this.stderrLine(`    ling-stack --daemon-url ${shellQuote(this.options.daemonUrl)} --cwd ${shellQuote(this.options.cwd)} approvals deny ${shellQuote(approvalId)}`);
  }

  private stdoutLine(value: string): void {
    this.options.writers.stdout.write(`${value}\n`);
  }

  private stderrLine(value: string): void {
    this.closeText();
    this.options.writers.stderr.write(`${value}\n`);
  }

  private closeText(): void {
    if (this.textOpen) {
      this.options.writers.stdout.write("\n");
      this.textOpen = false;
    }
  }
}

function summarizeToolName(data: unknown): string {
  return readString(data, "toolName") ?? readString(data, "name") ?? readString(data, "tool") ?? "<tool>";
}

function summarizeApprovalPayload(payload: unknown): string | undefined {
  if (payload === undefined || payload === null) {
    return undefined;
  }
  if (typeof payload === "string") {
    return truncate(payload, 240);
  }
  if (isRecord(payload) && readString(payload, "patchFormat")) {
    return truncate(summarizePatchApprovalPayload(payload), 240);
  }
  if (isRecord(payload) && readString(payload, "type") === "runtime_permission_request") {
    return truncate(summarizeRuntimePermissionPayload(payload), 240);
  }
  return truncate(summarizeUnknown(payload, 240), 240);
}

function summarizeRuntimePermissionPayload(payload: Record<string, unknown>): string {
  const requestKind = readString(payload, "requestKind") ?? "permission";
  const requestedScope = readField(payload, "requestedScope");
  const continuation = readField(payload, "proposedContinuation");
  const mode = isRecord(continuation) ? readString(continuation, "mode") : undefined;
  return `${requestKind}: ${summarizeRuntimePermissionScope(requestedScope)}${mode ? ` -> ${mode}` : ""}`;
}

function summarizeRuntimePermissionScope(scope: unknown): string {
  if (!isRecord(scope)) {
    return "<unknown scope>";
  }
  const kind = readString(scope, "kind");
  if (kind === "core_tool") {
    return `tools ${readStringArray(scope, "tools").join(", ") || "<none>"}`;
  }
  if (kind === "write_scope") {
    return `${readString(scope, "operation") ?? "write"} ${readStringArray(scope, "paths").join(", ") || "<none>"}`;
  }
  if (kind === "mcp_tool") {
    return `mcp ${readString(scope, "serverId") ?? "<server>"}/${readString(scope, "toolName") ?? "<tool>"}`;
  }
  if (kind === "runner_capability") {
    return `runner ${readString(scope, "runnerId") ?? "<runner>"}/${readString(scope, "capability") ?? "<capability>"}`;
  }
  return kind ?? "<unknown scope>";
}

function summarizePatchApprovalPayload(payload: Record<string, unknown>): string {
  const paths = readStringArray(payload, "touchedPaths");
  const summary = readField(payload, "summary");
  const fileCount = isRecord(summary) ? readNumber(summary, "fileCount") : undefined;
  const addedLines = isRecord(summary) ? readNumber(summary, "addedLines") : undefined;
  const removedLines = isRecord(summary) ? readNumber(summary, "removedLines") : undefined;
  const pathSummary = paths.length > 0 ? paths.join(", ") : readString(payload, "path") ?? "<unknown>";
  const statSummary = [
    fileCount !== undefined ? `${fileCount} files` : undefined,
    addedLines !== undefined ? `+${addedLines}` : undefined,
    removedLines !== undefined ? `-${removedLines}` : undefined,
  ].filter(Boolean).join(", ");
  return `${pathSummary}${statSummary ? ` (${statSummary})` : ""}`;
}

function summarizeResult(data: unknown): string {
  const summary = readString(data, "summary") ?? readString(data, "text") ?? readString(data, "message");
  return summary ? truncate(summary, 240) : summarizeUnknown(data, 240);
}

function summarizeUnifiedExecResult(data: unknown): string {
  const unifiedExec = readUnifiedExecResultData(data);
  if (!isRecord(unifiedExec)) {
    return "";
  }
  const denied = readBoolean(unifiedExec, "denied");
  const reason = readString(unifiedExec, "reason");
  if (denied) {
    return reason ?? "Command denied by policy.";
  }
  const status = readString(unifiedExec, "status");
  const exitCode = readNumber(unifiedExec, "exitCode");
  const durationMs = readNumber(unifiedExec, "durationMs");
  const duration = durationMs === undefined ? "" : `${durationMs}ms`;
  if (status === "timed_out") {
    return duration ? `Command timed out after ${duration}.` : "Command timed out.";
  }
  if (status === "cancelled") {
    return duration ? `Command cancelled after ${duration}.` : "Command cancelled.";
  }
  if (exitCode !== undefined) {
    return duration ? `Command exited ${exitCode} in ${duration}.` : `Command exited ${exitCode}.`;
  }
  if (status) {
    return duration ? `Command ${status} in ${duration}.` : `Command ${status}.`;
  }
  return reason ?? "";
}

function readUnifiedExecResultData(data: unknown): unknown {
  const candidates = [
    data,
    readField(data, "result"),
    readField(data, "partialResult"),
  ];
  for (const candidate of candidates) {
    const direct = readField(candidate, "unifiedExec");
    if (direct !== undefined) {
      return direct;
    }
    const details = readField(candidate, "details");
    const nested = readField(details, "unifiedExec");
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function summarizeUnknown(value: unknown, limit: number): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return truncate(value, limit);
  }
  try {
    return truncate(JSON.stringify(value), limit);
  } catch {
    return String(value);
  }
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  if (limit <= 3) {
    return value.slice(0, limit);
  }
  return `${value.slice(0, limit - 3)}...`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const field = readField(value, key);
  return typeof field === "number" ? field : undefined;
}

function readStringArray(value: unknown, key: string): string[] {
  const field = readField(value, key);
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [];
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  const field = readField(value, key);
  return typeof field === "boolean" ? field : undefined;
}
