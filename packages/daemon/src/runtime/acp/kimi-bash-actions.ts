import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";
import type { ApprovalPayload } from "@ling-stack/core";
import { classifyApprovalActionType, classifyBashRiskFlags } from "../../features/runs/action-classifier.js";
import { classifyApprovalRisk, evaluateApprovalActionPolicy } from "../../features/runs/approval-action-policy.js";
import { commandForPolicy } from "../adapters/native-command-policy.js";
import type { AcpPreparedApproval } from "./approval-journal.js";
import type { KimiActionPreparationOptions } from "./kimi-action-preparation.js";
import type { AcpPermissionRequest } from "./live-client.js";
import { text } from "./live-errors.js";

export interface KimiTerminalShell { readonly executable: string; readonly platform: "posix" | "win32" }
interface BashContext extends KimiActionPreparationOptions { readonly root: string; readonly revision: number; readonly nativePermission?: boolean }
const unsupported = (reason: string): AcpPreparedApproval => ({ kind: "unsupported", reason });

export function prepareKimiBashAction(request: AcpPermissionRequest, input: Readonly<Record<string, unknown>>,
  context: BashContext): AcpPreparedApproval {
  if (!bashInput(input)) return unsupported("invalid_command_input");
  const semantic = commandForPolicy(input.command);
  if (!semantic) return unsupported("unmapped_shell_construct");
  const cwd = resolve(context.cwd, input.cwd ?? ".");
  let contextCwd: string;
  try {
    if (input.cwd?.includes("://") || realpathSync(context.cwd) !== context.root) return unsupported("unmapped_working_directory");
    contextCwd = realpathSync(cwd);
    const path = relative(context.root, contextCwd);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || !statSync(contextCwd).isDirectory()) return unsupported("unmapped_working_directory");
  } catch { return unsupported("unmapped_working_directory"); }
  const payload: ApprovalPayload = { type: "bash", command: semantic, cwd,
    riskFlags: [...new Set([...classifyBashRiskFlags(input.command), ...classifyBashRiskFlags(semantic)])] };
  const action = { toolName: "bash", cwd };
  const evaluated = evaluateApprovalActionPolicy({ ...context, request: action,
    approvalInput: { actionType: classifyApprovalActionType("bash", payload), risk: classifyApprovalRisk(action, payload),
      toolCallId: request.params.toolCall.toolCallId, title: "Approve shell command", description: input.command,
      payload, extraSecrets: context.extraSecrets } });
  return { kind: "action", contextRevision: context.revision, contextCwd,
    approval: { ...evaluated.approvalInput, payload: { ...payload, command: input.command } },
    policyDecision: context.nativePermission !== false && evaluated.policyDecision.decision === "allow"
      ? { decision: "ask", reason: "The native engine requires explicit approval for this action." } : evaluated.policyDecision };
}

/** The shell identity is supplied by the owning runtime, never inferred from the request. */
export function matchesKimiBashTerminal(params: CreateTerminalRequest, shell: KimiTerminalShell,
  cwd: string, command: string): boolean {
  const expectedEnv: Readonly<Record<string, string>> = { NO_COLOR: "1", TERM: "dumb", GIT_TERMINAL_PROMPT: "0", SHELL: shell.executable };
  if (params.command !== shell.executable || !Array.isArray(params.args) || params.args.length !== 2 || params.args[0] !== "-c"
    || !Array.isArray(params.env) || params.env.length !== 4 || new Set(params.env.map(item => item.name)).size !== 4
    || params.env.some(item => !Object.hasOwn(expectedEnv, item.name) || item.value !== expectedEnv[item.name])) return false;
  const path = shell.platform === "win32" ? cwd.replaceAll("\\", "/").replace(/^([a-z]):(?=\/)/i,
    (_, drive: string) => `/${drive.toLowerCase()}`) : cwd;
  const body = shell.platform === "win32" ? command.replace(/(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g, "$1/dev/null") : command;
  return params.args[1] === `cd '${path.replaceAll("'", "'\\''")}' && ${body}`;
}

function bashInput(input: Readonly<Record<string, unknown>>): input is Readonly<Record<string, unknown>> & { command: string; cwd?: string } {
  if (Object.keys(input).some(key => !["command", "cwd", "timeout", "description", "run_in_background", "disable_timeout"].includes(key))) return false;
  return typeof input.command === "string" && !!input.command.trim() && !input.command.includes("\0")
    && (input.cwd === undefined || text(input.cwd))
    && (input.timeout === undefined || typeof input.timeout === "number" && Number.isSafeInteger(input.timeout) && input.timeout > 0 && input.timeout <= 300)
    && (input.description === undefined || typeof input.description === "string")
    && (input.run_in_background === undefined || input.run_in_background === false)
    && (input.disable_timeout === undefined || input.disable_timeout === false);
}
