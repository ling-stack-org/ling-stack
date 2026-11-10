import { lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { RunSession, RunStore } from "@ling-stack/core";
import type { PiRunnerApprovalRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import { workflowOperationEffectRejection } from "./workflow-operation-effect-gate.js";
import { validateWorkflowOperationRunContext } from "./workflow-operation-snapshot.js";

/**
 * Executes an approved typed native create instead of Pi's overwriting write.
 * O_CREAT|O_EXCL ("wx") makes destination no-clobber atomic. Ancestor checks are
 * userspace checks, not a kernel sandbox. No undeclared directories are created.
 * A partial new file is retained on I/O failure; unlinking a replaced path would
 * risk deleting another process's file. Legacy writes retain their old executor.
 */
export async function executeWorkflowOperationFileCreate(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: PiRunnerApprovalRequest;
  readonly signal?: AbortSignal;
}): Promise<PiRunnerToolHandledResult | undefined> {
  if (input.request.toolName !== "write") return undefined;
  const context = validateWorkflowOperationRunContext(input);
  if (context.status === "legacy") return undefined;
  if (context.status === "blocked") return failure(context.code, context.reason);
  const rejection = workflowOperationEffectRejection(input);
  if (rejection) return failure(rejection.code, rejection.reason);
  const value = input.request.input;
  if (!isRecord(value) || value.patchText !== undefined || value.patch !== undefined
    || typeof value.path !== "string" || typeof value.content !== "string"
    || value.content.trimStart().startsWith("*** Begin Patch")) {
    return failure("operation_binding_content_form_unsupported", "Typed create requires a native path/content write; patch creation is not an exclusive-create capability.");
  }
  const path = value.path;
  const content = value.content;
  let created = false;
  try {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Create cancelled.");
    let parent = realpathSync(context.run.cwd);
    const parts = path.split("/");
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return failure("operation_binding_symlink_rejected", "Typed create requires existing regular parent directories.");
      }
    }
    const handle = await open(join(parent, parts.at(-1)!), "wx", 0o600);
    created = true;
    try {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Create cancelled.");
      await handle.writeFile(content, "utf8");
      await handle.sync();
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Create cancelled.");
    } finally {
      await handle.close();
    }
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Create cancelled.");
    return {
      content: [{ type: "text", text: `Created ${path} exclusively (${Buffer.byteLength(content, "utf8")} bytes).` }],
      details: { path, touchedPaths: [path], exclusiveCreate: true },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failure(code === "EEXIST" ? "operation_binding_create_target_exists"
      : code === "ENOENT" ? "operation_binding_parent_missing" : "operation_binding_create_failed",
    `${error instanceof Error ? error.message : String(error)}${created ? " A partial newly created file may remain; it was not removed or retried." : ""}`);
  }
}

function failure(code: string, reason: string): PiRunnerToolHandledResult {
  return { isError: true, content: [{ type: "text", text: `${code}: ${reason}` }], details: { code } };
}
