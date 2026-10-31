import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isChannelOperationRelativePathV1, readHostCapabilityCallV1, type ChannelIntentExecutionOperationV1 } from "@ling-stack/contracts";
import { parseApplyPatch, type RunSession, type RunStore } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { verifyWorkflowStepExecutionOperations } from "../channels/workflow-operation-evidence.js";
import { validateWorkflowOperationRunContext, type WorkflowOperationBlock } from "./workflow-operation-snapshot.js";
import { commandWriteRiskRejection } from "./command-write-risk-gate.js";
import { commandMatchesPolicy } from "../channels/command-operation-match.js";
import { isNativeRestrictedCommandRuntime, type NativeRestrictedCommandRuntime } from "../../runtime/sandbox/restricted-command-runtime.js";

interface FileEffect {
  readonly path: string;
  readonly kind: "file_read" | "file_create" | "file_edit";
  readonly content?: string;
  readonly patch: boolean;
}

/**
 * Tool-boundary authority check, independent of approval policy. It never grants
 * permissions and must run again after approval waits and before resumed effects.
 * Symlink checks are best-effort userspace checks, not a kernel sandbox.
 */
export function workflowOperationEffectRejection(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: { readonly toolName: string; readonly input: unknown; readonly cwd: string };
  readonly restrictedCommandRuntime?: NativeRestrictedCommandRuntime;
}): WorkflowOperationBlock | undefined {
  const writeRisk = commandWriteRiskRejection(input);
  if (writeRisk) return writeRisk;
  return workflowOperationAuthorityRejection(input);
}

/** Recheck immutable authority after the Host journal has reserved this command.
 * This is not standalone admission: callers must first reserve through the journal.
 */
export function workflowOperationAuthorityRejection(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: { readonly toolName: string; readonly input: unknown; readonly cwd: string };
  readonly restrictedCommandRuntime?: NativeRestrictedCommandRuntime;
}): WorkflowOperationBlock | undefined {
  const context = validateWorkflowOperationRunContext(input);
  if (context.status === "legacy") return undefined;
  if (context.status === "blocked") return context;
  if (context.run.status !== "running" && context.run.status !== "waiting_for_approval") {
    return blocked("operation_binding_run_inactive", "Terminal or inactive Runs cannot dispatch another typed effect.");
  }
  const { request } = input;
  // Structured questions are a control-plane pause, not a file or command
  // effect. The dedicated user-input coordinator owns their validation,
  // durability and resume authority.
  if (request.toolName === "request_user_input") return undefined;
  if (!isAbsolute(context.run.cwd) || !isAbsolute(request.cwd) || resolve(request.cwd) !== resolve(context.run.cwd)
    || (isRecord(request.input) && request.input.cwd !== undefined
      && (typeof request.input.cwd !== "string" || resolve(request.input.cwd) !== resolve(context.run.cwd)))) {
    return blocked("operation_binding_cwd_mismatch", "Tool execution cwd differs from the immutable Run workspace.");
  }
  if (request.toolName === "bash") {
    if (!isNativeRestrictedCommandRuntime(input.restrictedCommandRuntime)) {
      return blocked("operation_binding_isolation_unavailable", "Typed bash requires the Host restricted command runtime; raw spawn is not a fallback.");
    }
    const command = isRecord(request.input) && typeof request.input.command === "string" ? request.input.command : "";
    const matches = context.ownedOperations.filter(operation => operation.kind === "run_command"
      && operation.commandMatchPolicy?.kind === "exact_command" && commandMatchesPolicy(command, operation.commandMatchPolicy)
      && operation.binding!.effectScope.exactCommands.includes(command));
    if (matches.length !== 1) return blocked("operation_binding_command_out_of_scope", "No unique owned operation authorizes this exact command.");
    const operation = matches[0]!;
    if (operation.binding!.effectScope.allowEnvironmentAccess || operation.binding!.effectScope.allowNetworkAccess
      || operation.binding!.effectScope.writePaths.length > 0) {
      return blocked("operation_binding_command_scope_unsupported", "This operation requires a capability not enforced by the selected command backend.");
    }
    try { input.restrictedCommandRuntime.assertAvailable(command); }
    catch (error) { return blocked("operation_binding_isolation_unavailable", error instanceof Error ? error.message : "Restricted runtime verification failed."); }
    return validateDependencies(input.store, context.step.workflowId, context.snapshot.plan.fingerprint!, operation);
  }
  if (request.toolName === "host_open_local_target") {
    let call;
    try {
      call = readHostCapabilityCallV1(request.toolName, request.input);
    } catch (error) {
      return blocked("operation_binding_input_invalid", error instanceof Error ? error.message : "Invalid Host open input.");
    }
    if (call.capabilityId !== "host.open_local_target") {
      return blocked("operation_binding_input_invalid", "Host capability does not match the selected workflow operation.");
    }
    const candidates = context.ownedOperations.filter((operation) => operation.kind === "open_local_target"
      && operation.binding!.effectScope.readPaths.includes(call.input.path));
    if (candidates.length !== 1) {
      return blocked("operation_binding_path_out_of_scope", "No unique owned operation authorizes this Host preview path.");
    }
    return validateDependencies(input.store, context.step.workflowId, context.snapshot.plan.fingerprint!, candidates[0]!);
  }
  if (!["read", "write", "edit"].includes(request.toolName)) {
    return blocked("operation_binding_tool_out_of_scope", "Tool is not part of the typed file-effect capability: " + request.toolName);
  }
  let effects: readonly FileEffect[];
  try {
    effects = fileEffects(request.toolName, request.input);
  } catch (error) {
    return blocked("operation_binding_input_invalid", error instanceof Error ? error.message : "Invalid file-effect input.");
  }
  for (const effect of effects) {
    // Pi 1.1's native file tools strip an @ prefix, expand ~ and normalize
    // these Unicode spaces. A bound literal path must not change interpretation
    // between the Host gate and the actual tool. This is syntax, not authority.
    if (effect.path.startsWith("@") || effect.path === "~" || effect.path.startsWith("~/")
      || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(effect.path)) {
      return blocked("operation_binding_path_reinterpreted", "The native runner would reinterpret this literal path; use an unambiguous workspace-relative path.");
    }
    const candidates = context.ownedOperations.filter((operation) => operation.kind === effect.kind
      && (effect.kind === "file_read" ? operation.binding!.effectScope.readPaths : operation.binding!.effectScope.writePaths).includes(effect.path));
    if (candidates.length !== 1) {
      return blocked("operation_binding_path_out_of_scope", "No unique owned operation authorizes " + effect.kind + " at " + effect.path);
    }
    const operation = candidates[0]!;
    const content = operation.binding!.contentSource;
    if (content?.kind === "literal") {
      if (effect.kind !== "file_create" || effect.patch) {
        return blocked("operation_binding_content_form_unsupported", "Literal content requires a native write; this edit or patch form is not verified.");
      }
      if (effect.content !== content.text) {
        return blocked("operation_binding_content_mismatch", "Write content differs from the bound literal.");
      }
    }
    const pathRejection = validateFileEffectPath(context.run.cwd, effect);
    if (pathRejection) return pathRejection;
    const dependencyRejection = validateDependencies(input.store, context.step.workflowId, context.snapshot.plan.fingerprint!, operation);
    if (dependencyRejection) return dependencyRejection;
  }
  return undefined;
}

function fileEffects(toolName: string, value: unknown): readonly FileEffect[] {
  if (!isRecord(value)) throw new Error("File tool input must be an object.");
  if (toolName !== "read") {
    const explicit = value.patchText ?? value.patch;
    const embedded = toolName === "write" && typeof value.content === "string"
      && value.content.trimStart().startsWith("*** Begin Patch") ? value.content : undefined;
    const patchText = explicit ?? embedded;
    if (patchText !== undefined) {
      if (typeof patchText !== "string") throw new Error("Patch must be text.");
      if (value.patchText !== undefined && value.patch !== undefined && value.patchText !== value.patch) throw new Error("Conflicting patch aliases.");
      const operations = parseApplyPatch(patchText).operations;
      if (operations.length === 0) throw new Error("Empty patch has no declared effect.");
      return operations.map((operation) => {
        if (!isChannelOperationRelativePathV1(operation.path)) throw new Error("Patch path must be canonical and workspace-relative.");
        if (operation.kind === "delete" || (toolName === "write" ? operation.kind !== "add" : operation.kind !== "update")) {
          throw new Error("Patch operation kind is not authorized by this tool binding.");
        }
        return { path: operation.path, kind: operation.kind === "add" ? "file_create" : "file_edit", patch: true };
      });
    }
  }
  if (!isChannelOperationRelativePathV1(value.path)) throw new Error("File path must be canonical and workspace-relative.");
  if (toolName === "write" && typeof value.content !== "string") throw new Error("Write content must be text.");
  return [{
    path: value.path,
    kind: toolName === "read" ? "file_read" : toolName === "write" ? "file_create" : "file_edit",
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    patch: false,
  }];
}

function validateFileEffectPath(cwd: string, effect: FileEffect): WorkflowOperationBlock | undefined {
  try {
    let current = realpathSync(resolve(cwd));
    const parts = effect.path.split("/");
    let missing = false;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) return blocked("operation_binding_symlink_rejected", "Typed file effects do not follow symbolic links.");
        if (index < parts.length - 1 && !stat.isDirectory()) return blocked("operation_binding_path_invalid", "A parent path is not a directory.");
        if (index === parts.length - 1) {
          if (!stat.isFile()) return blocked("operation_binding_path_invalid", "Target is not a regular file.");
          if (effect.kind === "file_create") return blocked("operation_binding_create_target_exists", "A file_create operation cannot overwrite an existing file.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing = true;
        break;
      }
    }
    if (missing && effect.kind !== "file_create") return blocked("operation_binding_target_missing", "Read or edit target is missing.");
    return undefined;
  } catch {
    return blocked("operation_binding_path_unverifiable", "The filesystem target could not be verified.");
  }
}

function validateDependencies(
  store: RunStore,
  workflowId: string,
  fingerprint: string,
  operation: ChannelIntentExecutionOperationV1,
): WorkflowOperationBlock | undefined {
  if (operation.dependsOn.length === 0) return undefined;
  const steps = store.listChannelWorkflowSteps({ workflowId, complete: true });
  for (const dependencyId of operation.dependsOn) {
    const owners = steps.filter((step) => step.metadata?.executionPlan?.fingerprint === fingerprint
      && step.metadata?.executionOperationIds?.includes(dependencyId));
    const step = owners.length === 1 ? owners[0] : undefined;
    const run = step?.runId ? store.getRun(step.runId) : undefined;
    if (!step || !run || validateWorkflowOperationRunContext({ store, run }).status !== "ready") {
      return blocked("operation_binding_dependency_unverified", "Dependency lacks a unique immutable owner Run: " + dependencyId);
    }
    const verification = verifyWorkflowStepExecutionOperations({ store, step, now: new Date().toISOString() });
    const results = verification?.operationResults.filter((result) => result.operationId === dependencyId) ?? [];
    if (results.length !== 1 || results[0]!.status !== "succeeded") {
      return blocked("operation_binding_dependency_unverified", "Dependency has no successful Host execution evidence: " + dependencyId);
    }
  }
  return undefined;
}

function blocked(code: string, reason: string): WorkflowOperationBlock {
  return { status: "blocked", code, reason };
}
