import { isAbsolute, relative, resolve } from "node:path";
import type { RunSession, UnifiedExecRequest } from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";

/** The same pure normalization at the public tool entry and original source-owned launcher. */
export function normalizeBashRequest(run: RunSession, approvalRequest: PiRunnerApprovalRequest,
  approvalId: string | undefined): { readonly request: UnifiedExecRequest } | { readonly request: UnifiedExecRequest; readonly error: string } {
  const command = readInputString(approvalRequest.input, "command", "");
  const requestedCwd = readInputString(approvalRequest.input, "cwd", approvalRequest.cwd || run.cwd);
  const cwd = isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(run.cwd, requestedCwd);
  const timeoutMs = readTimeoutMs(approvalRequest.input);
  const idleTimeoutMs = readInputNumber(approvalRequest.input, "idleTimeoutMs");
  const pty = isRecord(approvalRequest.input) && typeof approvalRequest.input.pty === "boolean" ? approvalRequest.input.pty : false;
  const request: UnifiedExecRequest = { runId: run.id, taskId: run.taskId, toolCallId: approvalRequest.toolCallId, approvalId,
    cwd, command: { kind: "shell", command, shell: "bash" }, timeoutMs, idleTimeoutMs, pty,
    environment: { mode: "inherit_minimal" }, startedBy: "run_tool" };
  if (!command.trim()) return { request, error: "Ling Stack unified exec rejected an empty bash command." };
  if (pty) return { request, error: "Ling Stack unified exec P1 does not support PTY shell commands." };
  const path = relative(resolve(run.cwd), resolve(cwd));
  if (path !== "" && (path.startsWith("..") || isAbsolute(path))) {
    return { request, error: `Ling Stack unified exec rejected cwd outside the run workspace: ${cwd}` };
  }
  return { request };
}
function readInputString(input: unknown, key: string, fallback: string): string {
  return isRecord(input) && typeof input[key] === "string" ? input[key] : fallback;
}
function readInputNumber(input: unknown, key: string): number | undefined {
  const value = isRecord(input) ? input[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function readTimeoutMs(input: unknown): number | undefined {
  const timeoutMs = readInputNumber(input, "timeoutMs");
  if (timeoutMs !== undefined) return timeoutMs;
  const seconds = readInputNumber(input, "timeout");
  return seconds === undefined ? undefined : Math.max(1, Math.floor(seconds * 1000));
}
