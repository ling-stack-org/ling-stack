import { isAbsolute, resolve } from "node:path";
import type { RunSession, RunStore } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { commandMatchesPolicy } from "../channels/command-operation-match.js";
import { validateWorkflowOperationRunContext } from "./workflow-operation-snapshot.js";
import { normalizeBashWorkingDirectory } from "./unified-exec-request.js";

export class WorkflowCommandBindingError extends Error {
  constructor(readonly code: string, readonly reason: string) {
    super(`${code}: ${reason}`);
    this.name = "WorkflowCommandBindingError";
  }
}

/** Pi supplies the session workspace. Bind ordinary cwd before any approval;
 * typed workflows may only use their immutable Host operation directory.
 */
export function bindWorkflowCommandRequest<T extends { readonly toolName: string; readonly input: unknown; readonly cwd: string }>(
  store: RunStore, run: RunSession, request: T,
): T {
  if (request.toolName !== "bash") return request;
  const context = validateWorkflowOperationRunContext({ store, run });
  if (context.status === "legacy") {
    const directory = normalizeBashWorkingDirectory(run, request);
    if (directory.error) throw new WorkflowCommandBindingError("command_cwd_invalid", directory.error);
    return { ...request, cwd: directory.cwd };
  }
  if (context.status === "blocked") throw new WorkflowCommandBindingError(context.code, context.reason);
  const command = isRecord(request.input) && typeof request.input.command === "string" ? request.input.command : "";
  const operations = context.ownedOperations.filter(operation => operation.kind === "run_command"
    && operation.commandMatchPolicy?.kind === "exact_command" && commandMatchesPolicy(command, operation.commandMatchPolicy)
    && operation.binding?.effectScope.exactCommands.includes(command));
  if (operations.length !== 1) throw new WorkflowCommandBindingError("operation_binding_command_out_of_scope",
    "No unique owned operation authorizes this exact command.");
  const cwd = resolve(run.cwd, operations[0]!.binding!.workingDirectory?.path ?? ".");
  if (!isAbsolute(run.cwd) || !isAbsolute(request.cwd)
    || (resolve(request.cwd) !== resolve(run.cwd) && resolve(request.cwd) !== cwd)
    || (isRecord(request.input) && request.input.cwd !== undefined
      && (typeof request.input.cwd !== "string" || resolve(run.cwd, request.input.cwd) !== cwd))) {
    throw new WorkflowCommandBindingError("operation_binding_cwd_mismatch",
      "Command execution cwd differs from the immutable operation directory.");
  }
  return { ...request, cwd };
}
