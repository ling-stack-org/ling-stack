import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { RequestError, type CreateTerminalResponse, type TerminalOutputRequest, type WaitForTerminalExitResponse } from "@agentclientprotocol/sdk";
import type { NativeHostAction } from "@ling-stack/core";
import { acpActionIdentity, sameAcpAction } from "./approval-journal.js";
import type { AcpHostHandler, AcpHostRequest } from "./host-requests.js";
import type { AcpHostTerminalCreateParams, AcpHostTerminalHandlers } from "./host-terminals.js";
import type { AcpHostActionContext } from "./journaled-lifecycle.js";
import { KimiActionPreparer, type KimiPreparedHostTerminal } from "./kimi-action-preparation.js";
import { startBoundedHostTerminal, type HostTerminalProcess, type HostTerminalProcessOptions } from "./host-terminal-process.js";
import { AcpLifecycleError } from "./live-errors.js";
import type { AcpReplyObservation } from "./live-stream.js";

type CreateRequest = AcpHostRequest<AcpHostTerminalCreateParams>;
type ControlRequest = AcpHostRequest<TerminalOutputRequest>;
interface Entry {
  readonly request: CreateRequest;
  readonly prepared: KimiPreparedHostTerminal;
  readonly action: NativeHostAction;
  readonly hostApprovalId?: string;
  operationId?: string;
  process?: HostTerminalProcess;
  exit?: Promise<WaitForTerminalExitResponse>;
  cleanup?: Promise<void>;
}
export interface KimiHostTerminalOptions extends Pick<HostTerminalProcessOptions, "workspaceRoot" | "policyProfileId" | "allowedWritePaths"> {
  readonly assertUnchanged?: () => void;
}
const method = "terminal/create";
function fail(): never { throw new AcpLifecycleError("host_commit_failed", "unknown"); }
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** The target owns command approval; the shared port owns protocol handles and cleanup. */
export class KimiHostTerminals implements AcpHostTerminalHandlers {
  readonly #context: AcpHostActionContext;
  readonly #actions: KimiActionPreparer;
  readonly #options: KimiHostTerminalOptions;
  readonly #requests = new Map<string | number, Entry | undefined>();
  readonly #terminals = new Map<string, Entry>();
  readonly #releaseRequests = new Map<ControlRequest["requestId"], { request: ControlRequest; entry: Entry }>();
  readonly create: AcpHostHandler<AcpHostTerminalCreateParams, CreateTerminalResponse> = {
    receive: (request, signal) => this.#receive(request, signal),
    execute: (request, signal) => this.#create(request, signal),
    beforeReply: (request, signal) => {
      const entry = this.#request(request, signal);
      this.#revalidate(entry, signal);
      this.#context.store.assertNativeHostTerminalReply({ ...this.#key(entry), kind: "create" }, this.#context.now());
      if (entry.hostApprovalId) this.#context.store.claimNativeApprovalReply({ approvalId: entry.hostApprovalId,
        fence: this.#context.key.fence }, this.#context.now());
    },
    onReplyOutcome: observation => this.#observeCreate(observation),
  };
  readonly output = this.#control("output", async entry => entry.process!.output());
  readonly waitForExit = this.#control("exit", async (entry, signal) => {
    await entry.process!.waitForExit(signal);
    return entry.exit!;
  });
  readonly kill = this.#control("exit", async entry => {
    await entry.process!.kill(); await entry.exit; return {};
  });
  readonly release: AcpHostHandler<TerminalOutputRequest, Record<string, never>> = {
    receive: (request, signal) => {
      this.#releaseRequests.set(request.requestId, { request: structuredClone(request), entry: this.#terminal(request, signal, "output") });
    },
    execute: async (request, signal) => {
      const entry = this.#terminal(request, signal, "output");
      await this.dispose(entry.request.params.terminalId); return {};
    },
    beforeReply: (request, signal) => {
      signal.throwIfAborted();
      const saved = this.#releaseRequests.get(request.requestId);
      if (!saved || !isDeepStrictEqual(saved.request, request)) fail();
      // Shared disposal precedes this reply. Keep its identity, not an active handle.
      this.#context.store.assertNativeHostTerminalReply({ ...this.#key(saved.entry), kind: "exit" }, this.#context.now());
    },
    onReplyOutcome: observation => { this.#releaseRequests.delete(observation.requestId); },
  };

  constructor(context: AcpHostActionContext, options: KimiHostTerminalOptions) {
    if (!(context.actions instanceof KimiActionPreparer)) throw new AcpLifecycleError("invalid_input");
    this.#actions = context.actions;
    this.#context = { ...context, key: structuredClone(context.key) };
    this.#options = { ...options, allowedWritePaths: [...options.allowedWritePaths] };
  }

  #receive(request: CreateRequest, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (request.requestId === null || this.#requests.has(request.requestId) || this.#terminals.size >= 64) fail();
    this.#requests.set(request.requestId, undefined);
    const prepared = this.#actions.prepareHostTerminal(request.params);
    if (!prepared || prepared.policyDecision.decision === "deny") return;
    const { store, key, now } = this.#context;
    const matches = store.synchronizeNativeApprovalWait(key, now()).approvals.filter(item => item.approval.toolCallId === prepared.toolCallId);
    if (matches.length > 1) fail();
    let approval = matches[0]?.approval;
    if (approval && (matches[0]!.correlation.method !== "session/request_permission"
      || approval.actionType !== prepared.approval.actionType || !["pending", "approved"].includes(approval.status)
      || this.#context.findNativeApproval(prepared, approval) !== approval.id)) return;
    let hostApprovalId: string | undefined;
    if (!approval && prepared.policyDecision.decision === "ask") {
      approval = store.createNativeApproval({ ...key, requestId: request.requestId, method,
        approval: { ...prepared.approval, expiresAt: new Date(Date.parse(now()) + 300_000).toISOString() } }, now()).approval;
      hostApprovalId = approval.id;
    }
    const action = store.reserveNativeHostAction({ ...key, nativeSessionId: this.#context.sessionId,
      toolCallId: prepared.toolCallId, actionFingerprint: fingerprint(acpActionIdentity(prepared)), policyFingerprint: fingerprint(prepared.policyDecision),
      methods: [method], authorization: approval ? { kind: "approval", approvalId: approval.id, payload: approval.payload } : { kind: "policy" } }, now()).action;
    const entry = { request: structuredClone(request), prepared, action, hostApprovalId };
    this.#requests.set(request.requestId, entry);
    this.#terminals.set(request.params.terminalId, entry);
  }

  async #create(request: CreateRequest, signal: AbortSignal): Promise<CreateTerminalResponse> {
    const entry = this.#request(request, signal);
    const { store, key, now } = this.#context;
    if (entry.action.authorization.kind === "approval") {
      if (await this.#context.waitForApproval(entry.action.authorization.approvalId, signal) !== "approve_once") {
        throw new RequestError(-32000, "Host terminal request denied.");
      }
      if (!entry.hostApprovalId) for (;;) {
        signal.throwIfAborted();
        const correlation = store.getNativeApprovalCorrelation(entry.action.authorization.approvalId);
        if (!correlation || correlation.resolvedAt || ["not_written", "unknown"].includes(correlation.replyStatus)) fail();
        if (correlation.replyStatus === "written") break;
        await delay(5, undefined, { signal });
      }
    }
    this.#revalidate(entry, signal);
    try {
      entry.process = await startBoundedHostTerminal({ ...this.#options, executable: request.params.command,
        args: request.params.args ?? [], cwd: request.params.cwd!, outputByteLimit: request.params.outputByteLimit ?? undefined,
        timeoutMs: entry.prepared.timeoutMs, signal,
        beforeSpawn: () => {
          this.#revalidate(entry, signal);
          this.#options.assertUnchanged?.();
          const operation = store.claimNativeHostOperation({ actionId: entry.action.id, fence: key.fence, step: 0,
            requestId: request.requestId as string | number, operationFingerprint: fingerprint(request.params),
            actionFingerprint: entry.action.actionFingerprint, policyFingerprint: entry.action.policyFingerprint }, now());
          entry.operationId = operation.id;
        } });
      store.recordNativeHostTerminalStart(this.#key(entry), now());
      entry.exit = entry.process.waitForExit().then(exit => {
        store.settleNativeHostTerminalExit({ ...this.#key(entry), exit: { exitCode: exit.exitCode ?? null, signal: exit.signal ?? null } }, now());
        return exit;
      });
      void entry.exit.catch(() => {});
      return { terminalId: request.params.terminalId };
    } catch (error) {
      try { if (entry.process) await (entry.cleanup = entry.process.dispose()); }
      finally {
        if (entry.operationId) store.settleNativeHostOperation({ operationId: entry.operationId,
          fence: key.fence, outcome: "unknown" }, now());
      }
      throw error;
    }
  }

  #control<R>(kind: "output" | "exit", execute: (entry: Entry, signal: AbortSignal) => Promise<R>): AcpHostHandler<TerminalOutputRequest, R> {
    return {
      receive: (request, signal) => { this.#terminal(request, signal, "output"); },
      execute: async (request, signal) => execute(this.#terminal(request, signal, "output"), signal),
      beforeReply: (request, signal) => { this.#terminal(request, signal, kind); },
      onReplyOutcome: () => {},
    };
  }

  #terminal(request: AcpHostRequest<TerminalOutputRequest>, signal: AbortSignal, kind: "output" | "exit"): Entry {
    signal.throwIfAborted();
    const entry = this.#terminals.get(request.params.terminalId);
    if (request.params.sessionId !== this.#context.sessionId || !entry?.process || !entry.exit) throw RequestError.resourceNotFound();
    this.#context.store.assertNativeHostTerminalReply({ ...this.#key(entry), kind }, this.#context.now());
    return entry;
  }

  async dispose(terminalId: string): Promise<void> {
    const entry = this.#terminals.get(terminalId);
    if (!entry?.process) { this.#terminals.delete(terminalId); return; }
    entry.cleanup ??= (async () => {
      try { await entry.process!.kill(); await entry.exit; }
      finally { await entry.process!.dispose(); }
    })();
    await entry.cleanup;
    this.#terminals.delete(terminalId);
  }

  #observeCreate(observation: AcpReplyObservation): void {
    if (observation.requestId === null || observation.method !== method) fail();
    const entry = this.#requests.get(observation.requestId);
    const { store, key, now } = this.#context;
    if (entry?.operationId) store.observeNativeHostOperationReply({ operationId: entry.operationId, fence: key.fence,
      requestId: observation.requestId, method, outcome: observation.outcome }, now());
    if (entry?.hostApprovalId) {
      const correlation = store.getNativeApprovalCorrelation(entry.hostApprovalId);
      if (correlation && !correlation.resolvedAt) {
        const approvalKey = { approvalId: entry.hostApprovalId, fence: key.fence };
        if (correlation.replyStatus === "claimed") store.settleNativeApprovalReply({ ...approvalKey, outcome: observation.outcome }, now());
        if (observation.outcome !== "written" || correlation.replyStatus !== "claimed") store.resolveNativeApprovalRequest(approvalKey, now());
      }
    }
    this.#requests.delete(observation.requestId);
  }

  #request(request: CreateRequest, signal: AbortSignal): Entry {
    signal.throwIfAborted();
    const entry = request.requestId !== null ? this.#requests.get(request.requestId) : undefined;
    if (!entry || !isDeepStrictEqual(entry.request, request)) throw new RequestError(-32000, "Host terminal request denied.");
    return entry;
  }

  #revalidate(entry: Entry, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!sameAcpAction(this.#actions.prepareHostTerminal(entry.request.params), entry.prepared)) fail();
    if (!entry.hostApprovalId && entry.action.authorization.kind === "approval"
      && this.#context.findNativeApproval(entry.prepared) !== entry.action.authorization.approvalId) fail();
  }

  #key(entry: Entry) {
    if (!entry.operationId) fail();
    return { operationId: entry.operationId, fence: this.#context.key.fence, terminalId: entry.request.params.terminalId };
  }
}
