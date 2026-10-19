import { isAbsolute } from "node:path";
import type { ApprovalPolicy, EffectiveRunPolicySnapshot, SkillApprovalProfile } from "@ling-stack/core";
import { classifyApprovalActionType, classifyBashRiskFlags } from "../../features/runs/action-classifier.js";
import { classifyApprovalRisk, evaluateApprovalActionPolicy } from "../../features/runs/approval-action-policy.js";
import { commandForPolicy } from "../adapters/native-command-policy.js";
import type { AcpApprovalPreparer, AcpPreparedApproval } from "./approval-journal.js";
import type { AcpPermissionRequest, AcpSessionUpdate } from "./live-client.js";
import { AcpLifecycleError, record, text } from "./live-errors.js";

export interface OpenClawActionPreparationOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly policy: ApprovalPolicy;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly extraSecrets?: readonly (string | undefined)[];
}

const unsupported = (reason: string): AcpPreparedApproval => ({ kind: "unsupported", reason });

/** Maps the pinned OpenClaw Gateway exec relay, never display text or broad shell authority. */
export class OpenClawActionPreparer implements AcpApprovalPreparer {
  readonly #options: OpenClawActionPreparationOptions;

  constructor(options: OpenClawActionPreparationOptions) {
    if (!text(options.sessionId) || !text(options.cwd) || !isAbsolute(options.cwd)) {
      throw new AcpLifecycleError("invalid_input");
    }
    this.#options = structuredClone(options);
  }

  receive(update: AcpSessionUpdate): void {
    if (update.sessionId !== this.#options.sessionId) throw new AcpLifecycleError("binding_mismatch");
  }

  prepare(request: AcpPermissionRequest): AcpPreparedApproval {
    const { params } = request;
    const tool = params.toolCall;
    if (params.sessionId !== this.#options.sessionId || tool.kind !== "execute" || tool.status !== "pending"
      || !record(tool.rawInput) || !record(tool._meta) || !canonicalOptions(params.options)) {
      return unsupported("unmapped_openclaw_request");
    }
    const input = tool.rawInput;
    const metadata = tool._meta;
    if (Object.keys(input).some(key => !["name", "approvalId", "command", "host"].includes(key))
      || Object.keys(metadata).some(key => !["toolName", "approvalId"].includes(key))
      || input.name !== "exec" || metadata.toolName !== "exec"
      || !boundedText(input.approvalId, 256) || metadata.approvalId !== input.approvalId
      || !boundedText(input.command, 4096) || !input.command.trim() || input.host !== "gateway") {
      return unsupported("unmapped_openclaw_request");
    }
    const semantic = commandForPolicy(input.command);
    if (!semantic) return unsupported("unmapped_shell_construct");
    const payload = { type: "bash" as const, command: semantic, cwd: this.#options.cwd,
      riskFlags: [...new Set([...classifyBashRiskFlags(input.command), ...classifyBashRiskFlags(semantic)])] };
    const action = { toolName: "bash", cwd: this.#options.cwd };
    const evaluated = evaluateApprovalActionPolicy({ ...this.#options, request: action,
      approvalInput: { actionType: classifyApprovalActionType("bash", payload), risk: classifyApprovalRisk(action, payload),
        toolCallId: tool.toolCallId, title: "Approve shell command", description: input.command,
        payload, extraSecrets: this.#options.extraSecrets } });
    return {
      kind: "action",
      contextIdentity: `openclaw-exec:${input.approvalId}`,
      contextCwd: this.#options.cwd,
      approval: { ...evaluated.approvalInput, payload: { ...payload, command: input.command } },
      policyDecision: evaluated.policyDecision.decision === "allow"
        ? { decision: "ask", reason: "The native engine requires explicit approval for this action." }
        : evaluated.policyDecision,
    };
  }

  clear(): void {}
}

function canonicalOptions(options: AcpPermissionRequest["params"]["options"]): boolean {
  if (options.length < 2 || options.length > 3 || new Set(options.map(option => option.optionId)).size !== options.length) return false;
  const expected = new Map([
    ["allow-once", "allow_once"],
    ["allow-always", "allow_always"],
    ["deny", "reject_once"],
  ]);
  return options.every(option => expected.get(option.optionId) === option.kind)
    && options.some(option => option.optionId === "allow-once")
    && options.some(option => option.optionId === "deny");
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\x00-\x1f\x7f]/.test(value);
}
