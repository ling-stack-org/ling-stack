import { isAbsolute, relative, resolve } from "node:path";
import type { RunSession, UnifiedExecRequest } from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";

/** Select once before approval; launch normalization uses the same directory contract.
 * A model-supplied cwd selects a location, never additional filesystem authority.
 */
export function normalizeBashWorkingDirectory(run: Pick<RunSession, "cwd">,
  approvalRequest: Pick<PiRunnerApprovalRequest, "cwd" | "input">): { readonly cwd: string; readonly error?: string } {
  const inputCwd = isRecord(approvalRequest.input) ? approvalRequest.input.cwd : undefined;
  if (inputCwd !== undefined && (typeof inputCwd !== "string" || !inputCwd.trim())) {
    return { cwd: resolve(run.cwd), error: "Ling Stack rejected a non-string or empty command cwd." };
  }
  const requestedCwd = typeof inputCwd === "string" ? inputCwd : approvalRequest.cwd || run.cwd;
  const cwd = isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(run.cwd, requestedCwd);
  const path = relative(resolve(run.cwd), cwd);
  if (path !== "" && (path.startsWith("..") || isAbsolute(path))) {
    return { cwd, error: `Ling Stack unified exec rejected cwd outside the run workspace: ${cwd}` };
  }
  return { cwd };
}

/** The same pure normalization at the public tool entry and original source-owned launcher. */
export function normalizeBashRequest(run: RunSession, approvalRequest: PiRunnerApprovalRequest,
  approvalId: string | undefined): { readonly request: UnifiedExecRequest } | { readonly request: UnifiedExecRequest; readonly error: string } {
  const command = readInputString(approvalRequest.input, "command", "");
  const directory = normalizeBashWorkingDirectory(run, approvalRequest);
  const cwd = directory.cwd;
  const timeoutMs = readTimeoutMs(approvalRequest.input);
  const idleTimeoutMs = readInputNumber(approvalRequest.input, "idleTimeoutMs");
  const pty = isRecord(approvalRequest.input) && typeof approvalRequest.input.pty === "boolean" ? approvalRequest.input.pty : false;
  const request: UnifiedExecRequest = { runId: run.id, taskId: run.taskId, toolCallId: approvalRequest.toolCallId, approvalId,
    cwd, command: { kind: "shell", command, shell: "bash" }, timeoutMs, idleTimeoutMs, pty,
    environment: { mode: "inherit_minimal" }, startedBy: "run_tool" };
  if (!command.trim()) return { request, error: "Ling Stack unified exec rejected an empty bash command." };
  if (pty) return { request, error: "Ling Stack unified exec P1 does not support PTY shell commands." };
  if (directory.error) return { request, error: directory.error };
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
