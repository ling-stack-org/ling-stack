import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CreateTerminalRequest, ReadTextFileRequest, WriteTextFileRequest } from "@agentclientprotocol/sdk";
import type { ApprovalPolicy, EffectiveRunPolicySnapshot, SkillApprovalProfile } from "@ling-stack/core";
import type { AcpApprovalPreparer, AcpPreparedApproval } from "./approval-journal.js";
import type { AcpPermissionRequest, AcpSessionUpdate } from "./live-client.js";
import { AcpLifecycleError, record, text } from "./live-errors.js";
import { mergeAcpToolObservation } from "./tool-observation.js";
import { prepareKimiFileAction } from "./kimi-file-actions.js";
import { matchesKimiBashTerminal, prepareKimiBashAction, type KimiTerminalShell } from "./kimi-bash-actions.js";
import type { NativeSecretRegistry } from "../adapters/native-stream-redaction.js";

export interface KimiActionPreparationOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly policy: ApprovalPolicy;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly nativeTools?: readonly string[];
  readonly terminalShell?: KimiTerminalShell;
  readonly limits?: { readonly items?: number; readonly bytes?: number };
}
const unsupported = (reason: string): AcpPreparedApproval => ({ kind: "unsupported", reason });
interface ToolEntry { readonly value: Readonly<Record<string, unknown>>; readonly revision: number; readonly bytes: number }
export type KimiPreparedHostFile = Extract<AcpPreparedApproval, { kind: "action" }> & {
  readonly toolCallId: string;
  readonly tool: "Read" | "Write" | "Edit";
  readonly input: Readonly<Record<string, unknown>>;
};
export type KimiPreparedHostTerminal = Extract<AcpPreparedApproval, { kind: "action" }> & {
  readonly toolCallId: string;
  readonly tool: "Bash";
  readonly input: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
};

/** Pinned successor tool input, never command text inferred from ACP display content. */
export class KimiActionPreparer implements AcpApprovalPreparer {
  readonly #options: KimiActionPreparationOptions;
  readonly #tools = new Map<string, ToolEntry>();
  readonly #limits: { items: number; bytes: number };
  readonly #root: string;
  readonly #secretRegistry?: NativeSecretRegistry;
  #revision = 0;
  #bytes = 0;

  constructor(options: KimiActionPreparationOptions, secretRegistry?: NativeSecretRegistry) {
    if (!text(options.sessionId) || !text(options.cwd) || !isAbsolute(options.cwd)
      || options.nativeTools && (!Array.isArray(options.nativeTools) || options.nativeTools.length > 4
        || options.nativeTools.some(tool => !["Bash", "Read", "Write", "Edit"].includes(tool)))) throw new AcpLifecycleError("invalid_input");
    if (options.terminalShell && (!["posix", "win32"].includes(options.terminalShell.platform)
      || !text(options.terminalShell.executable)
      || !(options.terminalShell.platform === "win32" ? win32.isAbsolute : isAbsolute)(options.terminalShell.executable))) {
      throw new AcpLifecycleError("invalid_input");
    }
    this.#options = structuredClone(options);
    this.#secretRegistry = secretRegistry;
    secretRegistry?.register((options.extraSecrets ?? []).filter((value): value is string => Boolean(value)));
    try {
      this.#root = realpathSync(options.cwd);
      if (!statSync(this.#root).isDirectory()) throw new Error("not_directory");
    } catch { throw new AcpLifecycleError("invalid_input"); }
    this.#limits = { items: options.limits?.items ?? 256, bytes: options.limits?.bytes ?? 4 * 1024 * 1024 };
    if (Object.values(this.#limits).some(value => !Number.isSafeInteger(value) || value < 1 || value > 2 ** 30)) throw new AcpLifecycleError("invalid_input");
  }

  receive(event: AcpSessionUpdate): void {
    if (event.sessionId !== this.#options.sessionId) throw new AcpLifecycleError("binding_mismatch");
    const update = event.update;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    if (!text(update.toolCallId)) throw new AcpLifecycleError("protocol_error");
    const previous = this.#tools.get(update.toolCallId);
    if ((update.sessionUpdate === "tool_call") === Boolean(previous)
      || previous?.value.status === "completed" || previous?.value.status === "failed") throw new AcpLifecycleError("protocol_error");
    const merged = mergeAcpToolObservation(previous?.value, update);
    if (!["pending", "in_progress", "completed", "failed"].some(status => status === merged.status)) throw new AcpLifecycleError("protocol_error");
    const value = structuredClone({ kind: merged.kind, status: merged.status,
      rawInput: merged.status === "completed" || merged.status === "failed" ? undefined : merged.rawInput });
    const changed = !previous || !isDeepStrictEqual(previous.value, value);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const total = this.#bytes - (previous?.bytes ?? 0) + bytes;
    if ((!previous && this.#tools.size >= this.#limits.items) || total > this.#limits.bytes
      || this.#revision >= Number.MAX_SAFE_INTEGER) throw new AcpLifecycleError("output_limit");
    this.#tools.set(update.toolCallId, { value, bytes, revision: changed ? ++this.#revision : previous!.revision });
    this.#bytes = total;
  }

  prepare(request: AcpPermissionRequest): AcpPreparedApproval {
    const { params } = request;
    if (params.sessionId !== this.#options.sessionId || !["Bash", "Write", "Read", "Edit"].includes(params.toolCall.title ?? "")
      || this.#options.nativeTools && !this.#options.nativeTools.some(tool => tool === params.toolCall.title)
      || !text(params.toolCall.toolCallId) || !canonicalOptions(request)
      || params.toolCall.rawInput !== undefined) return unsupported("unmapped_kimi_request");
    const entry = this.#tools.get(params.toolCall.toolCallId);
    const tool = entry?.value;
    const expectedKind = params.toolCall.title === "Bash" ? "execute" : params.toolCall.title === "Read" ? "read" : "edit";
    if (!tool || tool.status !== "in_progress" || tool.kind !== expectedKind || !record(tool.rawInput)
      || (params.toolCall.kind !== undefined && params.toolCall.kind !== expectedKind)) return unsupported("missing_tool_context");
    const input = tool.rawInput;
    if (params.toolCall.title !== "Bash") return prepareKimiFileAction(request, input,
      this.#context(entry!.revision));
    return prepareKimiBashAction(request, input, this.#context(entry!.revision));
  }

  prepareHostFile(params: ReadTextFileRequest | WriteTextFileRequest): KimiPreparedHostFile | undefined {
    if (params.sessionId !== this.#options.sessionId || !text(params.path) || !isAbsolute(params.path)
      || ("line" in params && params.line != null) || ("limit" in params && params.limit != null)) return undefined;
    const candidates: KimiPreparedHostFile[] = [];
    for (const [toolCallId, entry] of this.#tools) {
      if (entry.value.status !== "in_progress" || !record(entry.value.rawInput)) continue;
      const input = entry.value.rawInput;
      const tool = entry.value.kind === "read" ? "Read" : entry.value.kind === "edit"
        ? typeof input.content === "string" ? "Write" : "Edit" : undefined;
      if (!tool || this.#options.nativeTools && !this.#options.nativeTools.includes(tool)) continue;
      const prepared = prepareKimiFileAction({ requestId: null, params: { sessionId: params.sessionId,
        toolCall: { toolCallId, title: tool }, options: [] } }, input,
      this.#context(entry.revision, false));
      if (prepared.kind !== "action") continue;
      const payload = prepared.approval.payload;
      const path = payload.type === "file_write" || payload.type === "file_edit" ? payload.path
        : payload.type === "tool_call" && record(payload.input) ? payload.input.path : undefined;
      if (params.path !== resolve(this.#options.cwd, String(input.path)) && params.path !== path) continue;
      candidates.push({ ...prepared, toolCallId, tool, input });
    }
    return candidates.length === 1 ? structuredClone(candidates[0]) : undefined;
  }

  prepareHostTerminal(params: CreateTerminalRequest): KimiPreparedHostTerminal | undefined {
    const shell = this.#options.terminalShell;
    if (!shell || params.sessionId !== this.#options.sessionId || params.cwd !== this.#options.cwd
      || this.#options.nativeTools && !this.#options.nativeTools.includes("Bash")) return undefined;
    const candidates: KimiPreparedHostTerminal[] = [];
    for (const [toolCallId, entry] of this.#tools) {
      if (entry.value.status !== "in_progress" || entry.value.kind !== "execute" || !record(entry.value.rawInput)) continue;
      const input = entry.value.rawInput;
      const prepared = prepareKimiBashAction({ requestId: null, params: { sessionId: params.sessionId,
        toolCall: { toolCallId, title: "Bash" }, options: [] } }, input,
      this.#context(entry.revision, false));
      if (prepared.kind !== "action" || prepared.approval.payload.type !== "bash") continue;
      const { cwd, command } = prepared.approval.payload;
      if (!cwd || !matchesKimiBashTerminal(params, shell, cwd, command)) continue;
      candidates.push({ ...prepared, toolCallId, tool: "Bash", input, timeoutMs: Number(input.timeout ?? 60) * 1000 });
    }
    return candidates.length === 1 ? structuredClone(candidates[0]) : undefined;
  }

  clear(): void { this.#tools.clear(); this.#bytes = 0; }

  #context(revision: number, nativePermission?: boolean) {
    return { ...this.#options, root: this.#root, revision, nativePermission,
      extraSecrets: this.#secretRegistry?.getSnapshot() ?? this.#options.extraSecrets };
  }
}

function canonicalOptions(request: AcpPermissionRequest): boolean {
  const options = request.params.options;
  if (options.length !== 3 || new Set(options.map(option => option.optionId)).size !== 3) return false;
  return options.every(option => ({ approve_once: "allow_once", approve_always: "allow_always", reject: "reject_once" })[option.optionId] === option.kind);
}
