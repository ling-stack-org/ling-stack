import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ApprovalPayload, ApprovalPolicy, CreateNativeApprovalInput, EffectiveRunPolicySnapshot, SkillApprovalProfile } from "@ling-stack/core";
import { classifyApprovalActionType, classifyBashRiskFlags } from "../../../features/runs/action-classifier.js";
import { classifyApprovalRisk, evaluateApprovalActionPolicy, type ApprovalActionPolicyDecision } from "../../../features/runs/approval-action-policy.js";
import { assertNoInternalPatchPaths, assertNoSymlinkEscapes, assertPatchPathsWithinAllowedWritePaths } from "../../../features/runs/patch-actions.js";
import { CodexRpcError, type CodexRequest } from "./duplex.js";
import type { CodexFileChangeContext } from "./file-change-context.js";
import { prepareCodexPermissionAction } from "./permission-preparation.js";
import { commandForPolicy } from "../native-command-policy.js";
import { readCodexLocalEnvironment, type CodexLocalEnvironment } from "./local-environment.js";
import type { CodexThreadBinding } from "./live-client.js";

export interface CodexApprovalPolicyContext {
  readonly policy: ApprovalPolicy;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
}
export type CodexPreparedAction = {
  readonly kind: "action";
  readonly approval: CreateNativeApprovalInput["approval"];
  readonly policyDecision: ApprovalActionPolicyDecision;
  readonly denialDecision: "decline" | "cancel";
  readonly fileRevision?: number;
} | { readonly kind: "unsupported"; readonly reason: string };

const unsupported = (reason: string): CodexPreparedAction => ({ kind: "unsupported", reason });

/** Normalizes only proven native scopes. It never executes a command/patch or decides for the user. */
export class CodexActionPreparer {
  readonly #policy: CodexApprovalPolicyContext;
  #thread?: { readonly id: string; readonly environment?: CodexLocalEnvironment };
  constructor(readonly cwd: string, policy: CodexApprovalPolicyContext, readonly files: CodexFileChangeContext) {
    this.#policy = structuredClone(policy);
  }

  bindThreadEnvironment(binding: CodexThreadBinding): void {
    if (this.#thread || !id(binding.threadId) || binding.configuration.cwd !== this.cwd) throw new CodexRpcError("protocol_error");
    const environment = readCodexLocalEnvironment(binding.localEnvironment ? [binding.localEnvironment] : undefined, this.cwd);
    if (environment === null) throw new CodexRpcError("protocol_error");
    this.#thread = { id: binding.threadId, ...(environment ? { environment } : {}) };
  }

  prepare(request: CodexRequest): CodexPreparedAction {
    const params = request.params;
    if (!record(params) || !id(params.threadId) || !id(params.turnId) || !id(params.itemId)) return unsupported("invalid_identity");
    if (request.method === "item/commandExecution/requestApproval") return this.#command(params);
    if (request.method === "item/permissions/requestApproval") return prepareCodexPermissionAction(params, this.cwd, this.#policy);
    if (request.method !== "item/fileChange/requestApproval") return unsupported("unmapped_native_request");
    if (params.grantRoot != null || (params.environmentId != null && !this.#localEnvironment(params))) return unsupported("expanded_file_scope");
    const item = this.files.read(params.threadId, params.turnId, params.itemId);
    if (!item) return unsupported("missing_file_context");
    const rawPaths = item.changes.flatMap(change => change.kind.type === "update" && change.kind.move_path
      ? [change.path, change.kind.move_path] : [change.path]);
    if (rawPaths.some(path => !localPath(path))) return unsupported("nonlocal_file_path");
    const paths = [...new Set(rawPaths.map(path => relative(this.cwd, resolve(this.cwd, path)).split(sep).join("/")))];
    const payload: ApprovalPayload = { type: "file_edit", path: paths[0]!, touchedPaths: paths,
      diffPreview: item.changes.map(change => `${change.kind.type}: ${change.path}${change.kind.type === "update" && change.kind.move_path ? ` -> ${change.kind.move_path}` : ""}\n${change.diff}`).join("\n\n") };
    const tools = [...new Set(item.changes.flatMap(change => change.kind.type === "add" ? ["write"]
      : change.kind.type === "update" && change.kind.move_path ? ["edit", "write"] : ["edit"]))];
    let result = this.#evaluate(params.itemId, tools[0]!, this.cwd, payload);
    for (const tool of tools.slice(1)) {
      const next = this.#evaluate(params.itemId, tool, this.cwd, payload);
      if (next.policyDecision.decision === "deny" || (result.policyDecision.decision !== "deny" && next.policyDecision.decision === "ask")) {
        result = { ...result, policyDecision: next.policyDecision };
      }
      if (next.approval.risk === "high" || next.approval.risk === "critical") result = { ...result, approval: { ...result.approval, risk: next.approval.risk } };
    }
    try { this.#assertFileScope(paths); }
    catch { result = { ...result, policyDecision: { decision: "deny", reason: "Native file changes exceed the permitted write scope." } }; }
    return { ...result, fileRevision: item.revision };
  }

  assertCurrent(request: CodexRequest, prepared: CodexPreparedAction): void {
    const current = this.prepare(request);
    if (current.kind !== "action" || current.policyDecision.decision === "deny" || !isDeepStrictEqual(current, prepared)) {
      throw new CodexRpcError("handler_failed");
    }
  }

  #command(params: Record<string, unknown> & { itemId?: unknown }): CodexPreparedAction {
    // These experimental fields are present only after explicit initialize negotiation.
    if ((params.kind !== undefined && params.kind !== "command") || (params.environmentId != null && !this.#localCommandEnvironment(params))
      || params.additionalPermissions != null || params.networkApprovalContext != null) return unsupported("expanded_command_scope");
    if (typeof params.command !== "string" || !params.command.trim() || params.command.includes("\0")
      || typeof params.cwd !== "string" || !localPath(params.cwd) || !isAbsolute(params.cwd)) return unsupported("missing_command_context");
    const decisions = params.availableDecisions;
    if (decisions != null && (!Array.isArray(decisions) || !decisions.length || !decisions.every(nativeDecision))) return unsupported("invalid_native_decisions");
    const denialDecision = nativeDenialDecision(params);
    if (!denialDecision) return unsupported("missing_native_denial");
    const semantic = commandForPolicy(params.command);
    if (!semantic) return unsupported("unmapped_shell_construct");
    const riskFlags = [...new Set([...classifyBashRiskFlags(params.command), ...classifyBashRiskFlags(semantic)])];
    const payload: ApprovalPayload = { type: "bash", command: semantic, cwd: params.cwd, riskFlags };
    const result = this.#evaluate(params.itemId as string, "bash", params.cwd, payload, params.command);
    return { ...result, denialDecision, approval: { ...result.approval, payload: { ...payload, command: params.command } },
      policyDecision: Array.isArray(decisions) && !decisions.includes("accept")
        ? { decision: "deny", reason: "The native request does not offer a one-time approval." } : result.policyDecision };
  }

  #localCommandEnvironment(params: Record<string, unknown>): boolean {
    return this.#localEnvironment(params) && params.cwd === this.#thread?.environment?.cwd;
  }

  #localEnvironment(params: Record<string, unknown>): boolean {
    return !!this.#thread?.environment && params.threadId === this.#thread.id
      && params.environmentId === this.#thread.environment.environmentId;
  }

  #evaluate(itemId: string, toolName: string, cwd: string, payload: ApprovalPayload, description?: string): Extract<CodexPreparedAction, { kind: "action" }> {
    const request = { toolName, cwd };
    const evaluation = evaluateApprovalActionPolicy({ ...this.#policy, request,
      approvalInput: { actionType: toolName === "write" ? "write" : classifyApprovalActionType(toolName, payload),
        risk: classifyApprovalRisk(request, payload), toolCallId: itemId,
        title: toolName === "bash" ? "Approve shell command" : "Approve file edit",
        description: description ?? (payload.type === "file_edit" ? payload.touchedPaths!.join(", ") : ""), payload } });
    // A native approval callback is an additional boundary, not a saved Bash-rule lookup.
    const policyDecision = evaluation.policyDecision.decision === "allow"
      ? { decision: "ask" as const, reason: "The native engine requires explicit approval for this action." } : evaluation.policyDecision;
    return { kind: "action", approval: evaluation.approvalInput, policyDecision, denialDecision: "decline" };
  }

  #assertFileScope(paths: readonly string[]): void {
    assertNoInternalPatchPaths(paths);
    assertPatchPathsWithinAllowedWritePaths(paths, this.cwd, this.#policy.policy.allowedWritePaths);
    assertNoSymlinkEscapes(paths, this.cwd, this.#policy.policy.allowedWritePaths);
    for (const path of paths) {
      const absolute = resolve(this.cwd, path);
      let ancestor = absolute;
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      const realTarget = resolve(realpathSync(ancestor), relative(ancestor, absolute));
      assertNoInternalPatchPaths([relative(realpathSync(this.cwd), realTarget).split(sep).join("/")]);
    }
  }
}

export function nativeDenialDecision(params: unknown): "decline" | "cancel" | undefined {
  if (!record(params) || params.availableDecisions == null) return "decline";
  if (!Array.isArray(params.availableDecisions) || !params.availableDecisions.every(nativeDecision)) return undefined;
  return params.availableDecisions.includes("decline") ? "decline" : params.availableDecisions.includes("cancel") ? "cancel" : undefined;
}

function nativeDecision(value: unknown): boolean {
  if (typeof value === "string") return ["accept", "acceptForSession", "decline", "cancel"].includes(value);
  if (!record(value) || Object.keys(value).length !== 1) return false;
  const exec = value.acceptWithExecpolicyAmendment;
  if (record(exec) && Object.keys(exec).length === 1 && Array.isArray(exec.execpolicy_amendment)) {
    return exec.execpolicy_amendment.length > 0 && exec.execpolicy_amendment.every(token => typeof token === "string" && !!token && !token.includes("\0"));
  }
  const network = value.applyNetworkPolicyAmendment;
  if (!record(network) || Object.keys(network).length !== 1 || !record(network.network_policy_amendment)) return false;
  const amendment = network.network_policy_amendment;
  return Object.keys(amendment).length === 2 && typeof amendment.host === "string" && !!amendment.host && ["allow", "deny"].includes(String(amendment.action));
}
function localPath(value: string): boolean { return !!value && !/[\x00-\x1f\x7f]/.test(value) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value); }
