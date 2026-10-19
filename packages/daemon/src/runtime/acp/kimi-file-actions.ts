import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovalPayload } from "@ling-stack/core";
import { classifyApprovalRisk, evaluateApprovalActionPolicy } from "../../features/runs/approval-action-policy.js";
import { assertNoInternalPatchPaths, assertNoSymlinkEscapes, assertPatchPathsWithinAllowedWritePaths } from "../../features/runs/patch-actions.js";
import type { AcpPreparedApproval } from "./approval-journal.js";
import type { KimiActionPreparationOptions } from "./kimi-action-preparation.js";
import type { AcpPermissionRequest } from "./live-client.js";

interface FileContext extends KimiActionPreparationOptions { readonly root: string; readonly revision: number; readonly nativePermission?: boolean }
const unsupported = (reason: string): AcpPreparedApproval => ({ kind: "unsupported", reason });

/** Normalizes native parameters and observes path metadata; never reads/writes the file. */
export function prepareKimiFileAction(request: AcpPermissionRequest, input: Readonly<Record<string, unknown>>,
  context: FileContext): AcpPreparedApproval {
  const tool = request.params.toolCall.title;
  if (typeof input.path !== "string") return unsupported("invalid_file_input");
  if (tool === "Write") {
    if (Object.keys(input).some(key => !["path", "content", "mode"].includes(key)) || typeof input.content !== "string"
      || (input.mode !== undefined && input.mode !== "overwrite" && input.mode !== "append")) return unsupported("invalid_file_input");
  } else if (tool === "Read") {
    if (Object.keys(input).some(key => !["path", "line_offset", "n_lines"].includes(key))
      || (input.line_offset !== undefined && (!Number.isSafeInteger(input.line_offset) || Number(input.line_offset) === 0 || Number(input.line_offset) < -1000))
      || (input.n_lines !== undefined && (!Number.isSafeInteger(input.n_lines) || Number(input.n_lines) < 1))) return unsupported("invalid_file_input");
  } else if (tool === "Edit") {
    if (Object.keys(input).some(key => !["path", "old_string", "new_string", "replace_all"].includes(key))
      || typeof input.old_string !== "string" || !input.old_string || typeof input.new_string !== "string"
      || (input.replace_all !== undefined && typeof input.replace_all !== "boolean")) return unsupported("invalid_file_input");
  } else return unsupported("invalid_file_input");
  let path: string;
  try { path = resolveFileTarget(input.path, context, tool); }
  catch { return unsupported("unmapped_file_scope"); }
  const payload: ApprovalPayload = tool === "Write"
    ? { type: "file_write", path, bytes: Buffer.byteLength(input.content as string, "utf8"), preview: input.content as string }
    : tool === "Edit" ? { type: "file_edit", path, diffPreview: JSON.stringify({ old_string: input.old_string,
      new_string: input.new_string, replace_all: input.replace_all ?? false }, null, 2) }
    : { type: "tool_call", toolName: "read", cwd: context.root, input: { ...input, path, readScope: "whole_file" } };
  const toolName = tool === "Write" ? "write" : tool === "Edit" ? "edit" : "read";
  const action = { toolName, cwd: context.cwd };
  const evaluated = evaluateApprovalActionPolicy({ ...context, request: action, approvalInput: {
    actionType: toolName, risk: classifyApprovalRisk({ ...action, cwd: context.root }, payload), toolCallId: request.params.toolCall.toolCallId,
    extraSecrets: context.extraSecrets,
    title: tool === "Write" ? "Approve file write" : tool === "Edit" ? "Approve file edit" : `Approve ${toolName}`,
    description: JSON.stringify(tool === "Write" ? { tool, path: input.path, mode: input.mode ?? "overwrite" }
      : tool === "Edit" ? { tool, path: input.path, replace_all: input.replace_all ?? false } : { tool, ...input }),
    // Scope guards above check both paths; the shared policy uses the configured lexical namespace.
    payload: payload.type === "tool_call" ? payload : { ...payload, path: resolve(context.cwd, input.path) },
  } });
  return { kind: "action", contextRevision: context.revision, contextCwd: context.root, approval: { ...evaluated.approvalInput, payload },
    policyDecision: context.nativePermission !== false && evaluated.policyDecision.decision === "allow"
      ? { decision: "ask", reason: "The native engine requires explicit approval for this action." } : evaluated.policyDecision };
}

function resolveFileTarget(value: unknown, context: FileContext, tool: "Read" | "Write" | "Edit"): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("~")
    || value.startsWith("\\\\") || /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    || (process.platform === "win32" ? value.replace(/^[a-z]:/i, "").includes(":") : /^[a-z]:/i.test(value))
    || realpathSync(context.cwd) !== context.root) throw new Error("invalid_file_path");
  const absolute = resolve(context.cwd, value);
  let ancestor = absolute;
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  const canonicalAncestor = realpathSync(ancestor);
  const info = statSync(canonicalAncestor);
  if (ancestor === absolute ? !info.isFile() || info.nlink !== 1 : tool !== "Write" || !info.isDirectory()) throw new Error("invalid_file_target");
  const path = resolve(canonicalAncestor, relative(ancestor, absolute));
  const lexical = relative(context.cwd, absolute).split(sep).join("/");
  const physical = relative(context.root, path).split(sep).join("/");
  assertNoInternalPatchPaths([lexical, physical]);
  if ([absolute, path].some(item => item.split(sep).includes(".ling-stack"))) throw new Error("internal_file_path");
  if (tool !== "Read") {
    assertPatchPathsWithinAllowedWritePaths([absolute, path], context.cwd, context.policy.allowedWritePaths);
    assertNoSymlinkEscapes([absolute], context.cwd, context.policy.allowedWritePaths);
  } else if (!inside(context.cwd, absolute) || !inside(context.root, path)) throw new Error("outside_workspace");
  return path;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
