import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { RequestError, type ReadTextFileRequest, type ReadTextFileResponse, type WriteTextFileRequest, type WriteTextFileResponse } from "@agentclientprotocol/sdk";
import type { NativeHostAction } from "@ling-stack/core";
import { acpActionIdentity, sameAcpAction } from "./approval-journal.js";
import type { AcpHostFileHandler, AcpHostFileRequest } from "./host-files.js";
import type { AcpHostFileContext } from "./journaled-lifecycle.js";
import { KimiActionPreparer, type KimiPreparedHostFile } from "./kimi-action-preparation.js";
import { prepareBoundedHostText, type HostTextRead } from "./host-text-read.js";
import { HostTextWriteError, prepareBoundedHostWrite, type HostTextWrite } from "./host-text-write.js";
import { AcpLifecycleError, record } from "./live-errors.js";
import type { AcpReplyObservation } from "./live-stream.js";

type Request = AcpHostFileRequest<ReadTextFileRequest | WriteTextFileRequest>;
interface Entry {
  readonly request: Request;
  readonly prepared: KimiPreparedHostFile;
  readonly action: NativeHostAction;
  readonly hostApprovalId?: string;
  readonly step: 0 | 1;
  readonly previous?: Entry;
  operationId?: string;
  result?: HostTextRead | HostTextWrite;
  resultFingerprint?: string;
  replyWritten?: boolean;
}
const method = "fs/read_text_file";
function fail(): never { throw new AcpLifecycleError("host_commit_failed", "unknown"); }

/** One native file action owns its approval and ordered text effects. */
export class KimiHostFiles implements AcpHostFileHandler<ReadTextFileRequest, ReadTextFileResponse> {
  readonly #entries = new Map<string | number, Entry | undefined>();
  readonly #pairs = new Map<string, Entry>();
  readonly #context: AcpHostFileContext;
  readonly #actions: KimiActionPreparer;
  readonly writeTextFile: AcpHostFileHandler<WriteTextFileRequest, WriteTextFileResponse> = {
    receive: (request, signal) => this.#receive(request, signal),
    execute: (request, signal) => this.#write(request, signal),
    beforeReply: (request, signal) => this.beforeReply(request, signal),
    onReplyOutcome: observation => this.onReplyOutcome(observation),
  };

  constructor(context: AcpHostFileContext) {
    if (!(context.actions instanceof KimiActionPreparer)) throw new AcpLifecycleError("invalid_input");
    this.#actions = context.actions;
    this.#context = { ...context, key: structuredClone(context.key) };
  }

  receive(request: Request, signal: AbortSignal): void {
    this.#receive(request, signal);
  }

  #receive(request: Request, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (request.requestId === null || this.#entries.has(request.requestId) || this.#entries.size >= 64) fail();
    this.#entries.set(request.requestId, undefined);
    for (const [id, pair] of this.#pairs) {
      if (!sameAcpAction(this.#actions.prepareHostFile(pair.request.params), pair.prepared)) this.#pairs.delete(id);
    }
    const prepared = this.#actions.prepareHostFile(request.params);
    if (!prepared || prepared.policyDecision.decision === "deny") return;
    const writing = "content" in request.params;
    const paired = prepared.tool === "Edit" || prepared.tool === "Write" && prepared.input.mode === "append";
    if (writing && paired) {
      const previous = this.#pairs.get(prepared.toolCallId);
      if (!previous?.replyWritten || !previous.result || !("content" in previous.result)
        || !sameAcpAction(previous.prepared, prepared)
        || request.params.content !== expectedWrite(prepared, previous.result.content)) return;
      this.#entries.set(request.requestId, { request: structuredClone(request), prepared, action: previous.action,
        hostApprovalId: previous.hostApprovalId, step: 1, previous });
      return;
    }
    if (writing ? prepared.tool !== "Write" || request.params.content !== prepared.input.content
      : prepared.tool !== "Read" && !paired) return;
    const requestMethod = writing ? "fs/write_text_file" : method;
    const { store, key, now } = this.#context;
    const matches = store.synchronizeNativeApprovalWait(key, now()).approvals.filter(item => item.approval.toolCallId === prepared.toolCallId);
    if (matches.length > 1) fail();
    let approval = matches[0]?.approval;
    if (approval && (matches[0]!.correlation.method !== "session/request_permission"
      || approval.actionType !== prepared.approval.actionType
      || !["pending", "approved"].includes(approval.status)
      || this.#context.findNativeApproval(prepared, approval) !== approval.id)) return;
    let hostApprovalId: string | undefined;
    if (!approval && prepared.policyDecision.decision === "ask") {
      approval = store.createNativeApproval({ ...key, requestId: request.requestId, method: requestMethod,
        approval: { ...prepared.approval, expiresAt: new Date(Date.parse(now()) + 300_000).toISOString() } }, now()).approval;
      hostApprovalId = approval.id;
    }
    const action = store.reserveNativeHostAction({ ...key, nativeSessionId: this.#context.sessionId,
      toolCallId: prepared.toolCallId, actionFingerprint: fingerprint(acpActionIdentity(prepared)), policyFingerprint: fingerprint(prepared.policyDecision),
      methods: paired ? [method, "fs/write_text_file"] : [requestMethod],
      authorization: approval ? { kind: "approval", approvalId: approval.id, payload: approval.payload } : { kind: "policy" } }, now()).action;
    if (paired && this.#pairs.size >= 16) fail();
    const entry: Entry = { request: structuredClone(request), prepared, action, hostApprovalId, step: 0 };
    this.#entries.set(request.requestId, entry);
    if (paired) this.#pairs.set(prepared.toolCallId, entry);
  }

  async execute(request: Request, signal: AbortSignal): Promise<ReadTextFileResponse> {
    const entry = await this.#authorize(request, signal);
    const { store, key, now } = this.#context;
    const payload = entry.prepared.approval.payload;
    const path = payload.type === "file_write" || payload.type === "file_edit" ? payload.path
      : payload.type === "tool_call" && record(payload.input) ? payload.input.path : undefined;
    if (typeof path !== "string") fail();
    const file = prepareBoundedHostText(path, signal, { allowMissing: entry.prepared.tool === "Write" && entry.prepared.input.mode === "append" });
    let operation;
    try { operation = this.#claim(entry); }
    catch (error) { file.close(); throw error; }
    let succeeded = false;
    try {
      const result = file.read();
      entry.result = result;
      succeeded = true;
      entry.resultFingerprint = fingerprint(result.missing ? { missing: true } : { content: result.content });
      store.settleNativeHostOperation({ operationId: operation.id, fence: key.fence, outcome: "succeeded",
        resultFingerprint: entry.resultFingerprint }, now());
      if (result.missing) throw new RequestError(-32002, "Host file not found.");
      return { content: result.content };
    } catch (error) {
      if (!succeeded) store.settleNativeHostOperation({ operationId: operation.id, fence: key.fence, outcome: "failed" }, now());
      throw error;
    } finally { file.close(); }
  }

  async #authorize(request: Request, signal: AbortSignal): Promise<Entry> {
    const entry = this.#entry(request, signal);
    if (entry.action.authorization.kind === "approval"
      && await this.#context.waitForApproval(entry.action.authorization.approvalId, signal) !== "approve_once") {
      throw new RequestError(-32000, "Host file request denied.");
    }
    if (!entry.hostApprovalId && entry.action.authorization.kind === "approval") {
      for (;;) {
        signal.throwIfAborted();
        const correlation = this.#context.store.getNativeApprovalCorrelation(entry.action.authorization.approvalId);
        if (!correlation || correlation.resolvedAt || ["not_written", "unknown"].includes(correlation.replyStatus)) fail();
        if (correlation.replyStatus === "written") break;
        await delay(5, undefined, { signal });
      }
    }
    this.#revalidate(entry, signal);
    return entry;
  }

  #claim(entry: Entry) {
    const { store, key, now } = this.#context;
    const operation = store.claimNativeHostOperation({ actionId: entry.action.id, fence: key.fence, step: entry.step,
      requestId: entry.request.requestId as string | number, operationFingerprint: fingerprint(entry.request.params),
      actionFingerprint: entry.action.actionFingerprint, policyFingerprint: entry.action.policyFingerprint }, now());
    entry.operationId = operation.id;
    return operation;
  }

  async #write(request: AcpHostFileRequest<WriteTextFileRequest>, signal: AbortSignal): Promise<WriteTextFileResponse> {
    const entry = await this.#authorize(request, signal);
    const payload = entry.prepared.approval.payload;
    if (payload.type !== "file_write" && payload.type !== "file_edit") fail();
    const baseline = entry.previous?.result;
    const file = prepareBoundedHostWrite(payload.path, signal, baseline && "content" in baseline ? baseline : undefined);
    const operation = this.#claim(entry);
    const { store, key, now } = this.#context;
    let succeeded = false;
    try {
      entry.result = await file.write(request.params.content);
      succeeded = true;
      entry.resultFingerprint = fingerprint({ content: request.params.content });
      store.settleNativeHostOperation({ operationId: operation.id, fence: key.fence, outcome: "succeeded",
        resultFingerprint: entry.resultFingerprint }, now());
      return {};
    } catch (error) {
      if (!succeeded) store.settleNativeHostOperation({ operationId: operation.id, fence: key.fence,
        outcome: error instanceof HostTextWriteError ? error.outcome : "unknown" }, now());
      throw error;
    }
  }

  beforeReply(request: Request, signal: AbortSignal): void {
    const entry = this.#entry(request, signal);
    this.#revalidate(entry, signal);
    entry.result?.assertUnchanged();
    const { store, key, now } = this.#context;
    if (!entry.result || !entry.operationId || !entry.resultFingerprint) fail();
    store.assertNativeHostOperationReply({ operationId: entry.operationId, fence: key.fence,
      resultFingerprint: entry.resultFingerprint }, now());
    if (!entry.hostApprovalId && entry.action.authorization.kind === "approval"
      && this.#context.findNativeApproval(entry.prepared) !== entry.action.authorization.approvalId) fail();
    if (entry.hostApprovalId && entry.step === 0) store.claimNativeApprovalReply({ approvalId: entry.hostApprovalId, fence: key.fence }, now());
  }

  beforeErrorReply(request: Request, code: number, signal: AbortSignal): void {
    const entry = request.requestId !== null ? this.#entries.get(request.requestId) : undefined;
    if (code === -32002 && entry?.result && "missing" in entry.result && entry.result.missing) this.beforeReply(request, signal);
  }

  onReplyOutcome(observation: AcpReplyObservation): void {
    if (observation.requestId === null) fail();
    const entry = this.#entries.get(observation.requestId);
    if (entry?.operationId) {
      const { store, key, now } = this.#context;
      const method = entry.action.methods[entry.step]!;
      if (observation.method !== method) fail();
      store.observeNativeHostOperationReply({ operationId: entry.operationId, fence: key.fence,
        requestId: observation.requestId, method, outcome: observation.outcome }, now());
    }
    if (entry?.hostApprovalId && entry.step === 0) {
      const { store, key, now } = this.#context;
      const correlation = store.getNativeApprovalCorrelation(entry.hostApprovalId);
      if (correlation && !correlation.resolvedAt) {
        const approvalKey = { approvalId: entry.hostApprovalId, fence: key.fence };
        if (correlation.replyStatus === "claimed") store.settleNativeApprovalReply({ ...approvalKey, outcome: observation.outcome }, now());
        if (observation.outcome !== "written" || correlation.replyStatus !== "claimed") store.resolveNativeApprovalRequest(approvalKey, now());
      }
    }
    if (entry) {
      entry.replyWritten = observation.outcome === "written";
      if (entry.step === 1 || !entry.replyWritten || !entry.resultFingerprint) this.#pairs.delete(entry.prepared.toolCallId);
    }
    this.#entries.delete(observation.requestId);
  }

  #entry(request: Request, signal: AbortSignal): Entry {
    signal.throwIfAborted();
    const entry = request.requestId !== null ? this.#entries.get(request.requestId) : undefined;
    if (!entry || !isDeepStrictEqual(entry.request, request)) throw new RequestError(-32000, "Host file request denied.");
    return entry;
  }

  #revalidate(entry: Entry, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!sameAcpAction(this.#actions.prepareHostFile(entry.request.params), entry.prepared)) fail();
  }
}

function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function expectedWrite(prepared: KimiPreparedHostFile, original: string): string | undefined {
  const input = prepared.input;
  const maxBytes = 4 * 1024 * 1024;
  if (prepared.tool === "Write") return typeof input.content === "string"
    && Buffer.byteLength(original) + Buffer.byteLength(input.content) <= maxBytes ? original + input.content : undefined;
  if (prepared.tool !== "Edit" || typeof input.old_string !== "string" || !input.old_string
    || typeof input.new_string !== "string" || input.new_string === input.old_string) return undefined;
  // Kimi normalizes uniformly CRLF files, but preserves mixed/lone-CR text.
  const crlf = original.includes("\r\n") && !/[\r\n]/.test(original.replaceAll("\r\n", ""));
  const text = crlf ? original.replaceAll("\r\n", "\n") : original;
  let matches = 0;
  for (let position = text.indexOf(input.old_string); position !== -1; position = text.indexOf(input.old_string, position + input.old_string.length)) {
    matches++;
    if (!input.replace_all && matches > 1) return undefined;
  }
  if (!matches) return undefined;
  const bytes = Buffer.byteLength(text) + matches * (Buffer.byteLength(input.new_string) - Buffer.byteLength(input.old_string));
  if (bytes > maxBytes) return undefined;
  // Count before constructing the result; tiny raw inputs may request huge expansions.
  const replacement = input.new_string;
  const result = text.replaceAll(input.old_string, () => replacement);
  if (!crlf) return result;
  let expandedBytes = bytes;
  for (let index = 0; index < result.length; index++) {
    if (result[index] === "\n" && result[index - 1] !== "\r" && ++expandedBytes > maxBytes) return undefined;
  }
  return result.replace(/\r?\n/g, "\r\n");
}
