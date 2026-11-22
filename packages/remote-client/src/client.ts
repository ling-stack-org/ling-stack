import {
  REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1,
  REMOTE_PROTOCOL_VERSION,
  type DeviceApprovalBindingV1,
  type RemoteClientCommandPayloadMapV1,
  type RemoteClientCommandTypeV1,
  type RemoteClientFrameV1,
  type RemoteCommandFailedV1,
  type RemoteCommandResultMapV1,
  type RemoteDeviceApprovalPreviewV1,
  type RemoteDeviceCollaborationActionV1,
  type RemoteDeviceCollaborationViewV1,
  type RemoteDeviceTaskJournalCommandV1,
  type RemoteDeviceTaskJournalV1,
  type RemoteDeviceReconciliationPreviewV1,
  type RemoteConversationOpenCommandV1,
  type RemoteMarkConversationReadCommandV1,
  type RemoteProfileUpdateCommandV1,
  type RemoteResumeCursorV1,
  type RemoteSendTextCommandV1,
  type RemoteServerFrameV1,
} from "@ling-stack/contracts";
import {
  canonicalizeJson,
  parseRemoteAuthFrameV1,
  parseRemoteServerFrameV1,
  type RemoteMessageChannel,
} from "@ling-stack/remote-protocol";
import { verifyLingServerPairingPin } from "./ling-server-pairing-pin.js";
import {
  createRemoteSessionProof, openRemoteSessionChannel, type RemoteSessionAuthentication, type RemoteSessionConnectionOptions,
} from "./session-authentication.js";
import {
  createInitialRemoteClientState,
  reduceRemoteClientState,
  type RemoteClientState,
  type RemotePendingSend,
  type RemoteStateAction,
} from "./state.js";
import {
  type RemoteBindingStore,
  type RemoteBindingV1,
  type RemoteCacheStore,
  type RemoteClock,
  type RemoteDeviceKeyAdapter,
  type RemoteEntropy,
  type RemoteHttpClient,
} from "./types.js";

type CommandType = Exclude<RemoteClientCommandTypeV1, "stream.ack">;

export interface RemoteCommandHandle<TResult> {
  readonly commandId: string;
  readonly completion: Promise<TResult>;
}

export interface RemoteDeviceTaskJournalWatchOptions {
  readonly onUpdate: (journal: RemoteDeviceTaskJournalV1) => void;
  readonly onError?: (error: unknown) => void;
}

type DeviceJournalCursor = Pick<RemoteDeviceTaskJournalCommandV1, "generation" | "afterSequence" | "limit">;

interface DeviceJournalWatch extends RemoteDeviceTaskJournalWatchOptions {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly assertCurrent: () => void;
  cursor: DeviceJournalCursor;
  ownerId?: string;
}

interface PendingCommand<TResult = unknown> {
  readonly commandId: string;
  readonly messageId: string;
  readonly type: CommandType;
  readonly payload: RemoteClientCommandPayloadMapV1[CommandType];
  readonly resolve: (result: TResult) => void;
  readonly reject: (error: Error) => void;
}

interface RemoteSessionClientBaseOptions {
  readonly binding: RemoteBindingV1;
  readonly bindingStore: RemoteBindingStore;
  readonly cacheStore: RemoteCacheStore<RemoteClientState>;
  readonly keys: RemoteDeviceKeyAdapter;
  readonly entropy: RemoteEntropy;
  readonly clock: RemoteClock;
  readonly autoReconnect?: boolean;
}

export type RemoteSessionClientOptions = RemoteSessionClientBaseOptions & RemoteSessionConnectionOptions;

export class RemoteSessionClient {
  private binding: RemoteBindingV1;
  private stateValue = createInitialRemoteClientState();
  private readonly listeners = new Set<(state: RemoteClientState) => void>();
  private readonly commands = new Map<string, PendingCommand>();
  private readonly outboundByMessage = new Map<string, PendingCommand>();
  private readonly streamSequences = new Map<string, number>();
  private readonly streamSnapshots = new Map<string, string>();
  private readonly deviceJournalWatches = new Map<string, DeviceJournalWatch>();
  private socket?: RemoteMessageChannel;
  private detachSocket?: () => void;
  private authenticationAttempt?: AbortController;
  private connectPromise?: Promise<void>;
  private frameQueue = Promise.resolve();
  private bindingMutation = Promise.resolve();
  private unpairing = false;
  private clientSeq = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionalClose = false;
  private connectionGeneration = 0;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private expectedSessionId?: string;

  constructor(private readonly options: RemoteSessionClientOptions) {
    this.binding = options.binding;
  }

  get state(): RemoteClientState {
    return this.stateValue;
  }

  get activeBinding(): RemoteBindingV1 | undefined {
    return this.binding.status === "active" ? this.binding : undefined;
  }

  subscribe(listener: (state: RemoteClientState) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  async restoreCachedState(): Promise<void> {
    const workspaceBindingId = this.binding.workspaceBindingId;
    if (!workspaceBindingId) {
      return;
    }
    const cache = await this.options.cacheStore.read(workspaceBindingId);
    if (cache?.workspaceBindingId !== workspaceBindingId) {
      return;
    }
    this.stateValue = {
      ...cache.state,
      connection: "disconnected",
      deviceOverviewCurrent: false,
      deviceTaskCurrent: false,
      lastError: undefined,
    };
    this.emit();
  }

  async connect(): Promise<void> {
    if (this.binding.status !== "active") {
      throw new Error("remote_binding_revoked");
    }
    if (this.stateValue.connection === "connected") {
      return;
    }
    if (!this.connectPromise) {
      const generation = ++this.connectionGeneration;
      const tracked = this.openAuthenticatedSession(generation).finally(() => {
        if (this.connectPromise === tracked) {
          this.connectPromise = undefined;
        }
      });
      this.connectPromise = tracked;
    }
    return await this.connectPromise;
  }

  disconnect(): void {
    this.invalidateConnection(1000, "client_disconnect");
    this.dispatch({ type: "connection", status: "disconnected" });
  }

  async openConversation(conversationId: string, olderPageCursor?: string): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["conversation.open"]>> {
    const workspaceId = this.requireWorkspaceId();
    return await this.sendCommand("conversation.open", {
      commandId: await this.options.entropy.randomId("open"),
      workspaceId,
      conversationId,
      ...(olderPageCursor ? { olderPageCursor } : {}),
    });
  }

  async sendText(
    conversationId: string,
    body: string,
    retry?: Pick<RemotePendingSend, "commandId" | "issuedAt" | "retryUntil">,
  ): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["conversation.send_text"]>> {
    const now = this.options.clock.now();
    const payload: RemoteSendTextCommandV1 = {
      commandId: retry?.commandId ?? await this.options.entropy.randomId("send"),
      workspaceId: this.requireWorkspaceId(),
      conversationId,
      body: body.trim(),
      issuedAt: retry?.issuedAt ?? now,
      retryUntil: retry?.retryUntil ?? new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
    };
    if (!payload.body) {
      throw new Error("remote_message_empty");
    }
    this.dispatch({
      type: "send_started",
      send: {
        commandId: payload.commandId,
        conversationId,
        body: payload.body,
        issuedAt: payload.issuedAt,
        retryUntil: payload.retryUntil,
        status: "sending",
      },
    });
    try {
      return await this.sendCommand("conversation.send_text", payload);
    } catch (error) {
      this.dispatch({
        type: "send_failed",
        commandId: payload.commandId,
        error: {
          code: "pc_unavailable",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      });
      throw error;
    }
  }

  async retrySend(commandId: string): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["conversation.send_text"]>> {
    const pending = this.stateValue.pendingSends[commandId];
    if (!pending || pending.status !== "failed") {
      throw new Error("remote_retry_command_not_failed");
    }
    if (Date.parse(pending.retryUntil) < Date.parse(this.options.clock.now())) {
      throw new Error("remote_retry_window_expired");
    }
    return await this.sendText(pending.conversationId, pending.body, pending);
  }

  async markRead(conversationId: string, throughActivitySeq: number): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["conversation.mark_read"]>> {
    const payload: RemoteMarkConversationReadCommandV1 = {
      commandId: await this.options.entropy.randomId("read"),
      workspaceId: this.requireWorkspaceId(),
      conversationId,
      throughActivitySeq,
    };
    return await this.sendCommand("conversation.mark_read", payload);
  }

  async updateProfile(input: Omit<RemoteProfileUpdateCommandV1, "commandId" | "workspaceId">): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["profile.update"]>> {
    return await this.sendCommand("profile.update", {
      commandId: await this.options.entropy.randomId("profile"),
      workspaceId: this.requireWorkspaceId(),
      ...input,
    });
  }

  async requestDeviceList(): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["device.list"]>> {
    return await this.sendCommand("device.list", {
      commandId: await this.options.entropy.randomId("device_list"),
      workspaceId: this.requireDeviceWorkspaceId(),
    });
  }

  async requestDeviceTaskStatus(taskId: string): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["device.task.status"]>> {
    return await this.sendCommand("device.task.status", {
      commandId: await this.options.entropy.randomId("device_task"),
      workspaceId: this.requireDeviceWorkspaceId(),
      taskId,
    });
  }

  async readDeviceTaskJournal(taskId: string, cursor: Omit<DeviceJournalCursor, "limit"> & { readonly limit?: number }): Promise<RemoteDeviceTaskJournalV1> {
    const { workspaceId, assertCurrent } = this.deviceTaskAuthority("device.journal");
    const normalized = normalizeDeviceJournalCursor(cursor);
    const handle = await this.sendCommand("device.task.journal", {
      commandId: await this.options.entropy.randomId("device_task_journal"),
      workspaceId, taskId, ...normalized,
    }, assertCurrent);
    const result = await handle.completion;
    assertCurrent();
    if (result.kind !== "device_task_journal_read") throw new Error("remote_device_journal_binding_mismatch");
    assertDeviceJournalPage(result.journal, workspaceId, taskId, normalized);
    return result.journal;
  }

  async updateDeviceCollaboration(shareId: string, action: RemoteDeviceCollaborationActionV1): Promise<RemoteDeviceCollaborationViewV1> {
    const sessionId = this.requireSessionId();
    const workspaceId = this.requireWorkspaceId();
    const assertCurrent = () => {
      if (sessionId !== this.requireSessionId() || workspaceId !== this.requireWorkspaceId()
        || !this.stateValue.policy?.capabilities.includes("device.collaboration")) {
        throw new Error("remote_device_collaboration_unavailable");
      }
    };
    assertCurrent();
    const handle = await this.sendCommand("device.collaboration", {
      commandId: await this.options.entropy.randomId("device_collaboration"), workspaceId, shareId, action,
    }, assertCurrent);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const pending = this.commands.get(handle.commandId);
        if (pending) {
          this.commands.delete(handle.commandId);
          this.outboundByMessage.delete(pending.messageId);
        }
        reject(new Error("remote_device_collaboration_timed_out"));
      }, 15_000);
    });
    const { share } = await Promise.race([handle.completion, deadline]).finally(() => clearTimeout(timer));
    assertCurrent();
    if (share.shareId !== shareId || share.workspaceId !== workspaceId
      || (action.kind === "publish" && (share.state !== "active" || share.expiresAt !== action.expiresAt
        || ![action.expectedRevision, action.expectedRevision + 1].includes(share.revision)
        || canonicalizeJson(share.projection) !== canonicalizeJson(action.projection)))
      || (action.kind === "decide" && (share.state !== "active" || share.revision !== action.expectedRevision
        || !share.proposals.some(proposal => proposal.proposalId === action.proposalId && proposal.status === action.decision)))
      || (action.kind === "revoke" && share.state !== "revoked")) {
      throw new Error("remote_device_collaboration_binding_mismatch");
    }
    return share;
  }

  watchDeviceTaskJournal(
    taskId: string,
    cursor: Omit<DeviceJournalCursor, "limit"> & { readonly limit?: number },
    options: RemoteDeviceTaskJournalWatchOptions,
  ): () => void {
    const { workspaceId, assertCurrent } = this.deviceTaskAuthority("device.journal.watch");
    const watch: DeviceJournalWatch = { ...options, taskId, workspaceId, assertCurrent, cursor: normalizeDeviceJournalCursor(cursor) };
    let active = true;
    let watchId: string | undefined;
    let sent = false;
    const open = async () => {
      const commandId = await this.options.entropy.randomId("device_journal_watch");
      if (!active) return;
      watchId = commandId;
      this.deviceJournalWatches.set(commandId, watch);
      const handle = await this.sendCommand("device.task.journal.watch", { commandId, workspaceId, taskId, ...watch.cursor }, () => {
        assertCurrent();
        if (!active) throw new Error("remote_device_journal_watch_closed");
        sent = true;
      });
      const result = await handle.completion;
      if (result.kind !== "device_task_journal_watching") throw new Error("remote_device_journal_binding_mismatch");
    };
    void open().catch(error => {
      if (watchId && !this.deviceJournalWatches.delete(watchId)) return;
      if (active) options.onError?.(error);
    });
    return () => {
      if (!active) return;
      active = false;
      if (!watchId || !this.deviceJournalWatches.delete(watchId) || !sent) return;
      void this.stopDeviceJournalWatch(watchId, watch).catch(() => undefined);
    };
  }

  private async stopDeviceJournalWatch(watchId: string, watch: DeviceJournalWatch): Promise<void> {
    watch.assertCurrent();
    const handle = await this.sendCommand("device.task.journal.unwatch", {
      commandId: await this.options.entropy.randomId("device_journal_unwatch"),
      workspaceId: watch.workspaceId, taskId: watch.taskId, watchId,
    }, watch.assertCurrent);
    await handle.completion;
  }

  private applyDeviceJournalWatchPage(watchId: string, page: RemoteDeviceTaskJournalV1, initial: boolean): void {
    const watch = this.deviceJournalWatches.get(watchId);
    if (!watch) return;
    watch.assertCurrent();
    if (initial !== (watch.ownerId === undefined) || (watch.ownerId !== undefined && page.task.ownerId !== watch.ownerId)) {
      throw new Error("remote_device_journal_binding_mismatch");
    }
    assertDeviceJournalPage(page, watch.workspaceId, watch.taskId, watch.cursor);
    watch.ownerId = page.task.ownerId;
    watch.cursor = {
      ...watch.cursor,
      generation: page.generation,
      afterSequence: page.requiresSnapshot ? 0 : page.afterSequence + page.events.length,
    };
    watch.onUpdate(page);
  }

  async approveDeviceTask(taskId: string, preview: RemoteDeviceApprovalPreviewV1): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["device.task.approve"]>> {
    const authority = this.deviceTaskAuthority("device.approve");
    const assertApprovalCurrent = () => {
      authority.assertCurrent();
      const task = this.stateValue.deviceTask?.task;
      if (!this.stateValue.deviceTaskCurrent || task?.taskId !== taskId || task.status !== "awaiting_approval"
        || task.pendingApproval !== preview
        || (preview.recoveryPlan && Date.parse(preview.recoveryPlan.verifyBy) <= Date.parse(this.options.clock.now()))) {
        throw new Error("remote_device_approval_changed");
      }
    };
    assertApprovalCurrent();
    const approvalId = await this.options.entropy.randomId("device_approval");
    const expiresAt = new Date(Math.min(
      Date.parse(this.options.clock.now()) + 5 * 60_000,
      preview.recoveryPlan ? Date.parse(preview.recoveryPlan.verifyBy) : Number.POSITIVE_INFINITY,
    )).toISOString();
    const approval: DeviceApprovalBindingV1 = {
      approvalId,
      taskId,
      actionId: preview.actionId,
      targetDeviceId: preview.targetDeviceId,
      capabilitySnapshotId: preview.capabilitySnapshotId,
      connectionRevision: preview.connectionRevision,
      policyRevision: preview.policyRevision,
      normalizedInputDigest: preview.normalizedInputDigest,
      expiresAt,
      ...(preview.recoveryPlan ? { recoveryScope: preview.recoveryPlan } : {}),
    };
    return await this.sendCommand("device.task.approve", {
      commandId: await this.options.entropy.randomId("device_task_approve"),
      workspaceId: authority.workspaceId,
      taskId,
      approval,
    }, assertApprovalCurrent);
  }

  async revokeDeviceTask(taskId: string): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["device.task.revoke"]>> {
    const authority = this.deviceTaskAuthority("device.revoke");
    return await this.sendCommand("device.task.revoke", {
      commandId: await this.options.entropy.randomId("device_task_revoke"),
      workspaceId: authority.workspaceId,
      taskId,
    }, authority.assertCurrent);
  }

  async reconcileDeviceTask(taskId: string, preview: RemoteDeviceReconciliationPreviewV1): Promise<RemoteCommandHandle<RemoteCommandResultMapV1["device.task.reconcile"]>> {
    const authority = this.deviceTaskAuthority("device.reconcile");
    const assertReconciliationCurrent = () => {
      authority.assertCurrent();
      const task = this.stateValue.deviceTask?.task;
      if (!this.stateValue.deviceTaskCurrent || task?.taskId !== taskId || task.status !== "unknown"
        || task.pendingReconciliation !== preview) {
        throw new Error("remote_device_reconciliation_changed");
      }
    };
    assertReconciliationCurrent();
    return await this.sendCommand("device.task.reconcile", {
      commandId: await this.options.entropy.randomId("device_task_reconcile"),
      workspaceId: authority.workspaceId,
      taskId,
      attemptId: preview.attemptId,
      capabilitySnapshotId: preview.capabilitySnapshotId,
    }, assertReconciliationCurrent);
  }

  async requestFullResync(): Promise<void> {
    const handle = await this.sendCommand("snapshot.request", {
      commandId: await this.options.entropy.randomId("snapshot"),
      scope: { kind: "workspace", workspaceId: this.requireWorkspaceId() },
    });
    void handle.completion.catch(() => undefined);
  }

  async confirmLingServerPairingPin(confirmation: unknown, options: {
    readonly http?: RemoteHttpClient;
    readonly signal?: AbortSignal;
  } = {}): Promise<RemoteBindingV1> {
    const binding = this.binding;
    const http = options.http ?? this.options.http;
    if (!http) throw new Error("ling_server_pairing_http_unavailable");
    const assertCurrentPairing = () => {
      if (this.unpairing || this.binding.status !== "active" || this.binding.workspaceBindingId !== binding.workspaceBindingId) {
        throw new Error("ling_server_pairing_binding_changed");
      }
    };
    assertCurrentPairing();
    const { keys, entropy, clock } = this.options;
    const proof = await verifyLingServerPairingPin({ confirmation, binding, http, keys, entropy, clock, signal: options.signal });
    return await this.runBindingMutation(async () => {
      assertCurrentPairing();
      const current = this.binding;
      const stored = await this.options.bindingStore.read();
      assertCurrentPairing();
      options.signal?.throwIfAborted();
      const next = { ...current, lingServerRoutingProfile: proof.routingProfile };
      const storedBinding = stored && canonicalizeJson(stored);
      const currentBinding = canonicalizeJson(current);
      if (storedBinding !== canonicalizeJson(next)) {
        if (storedBinding !== currentBinding) {
          throw new Error("ling_server_pairing_binding_changed");
        }
        if (canonicalizeJson(current.lingServerRoutingProfile ?? null) !== canonicalizeJson(binding.lingServerRoutingProfile ?? null)) {
          throw new Error("ling_server_pairing_profile_changed");
        }
        await this.options.bindingStore.write(next);
        assertCurrentPairing();
      } else if (storedBinding === currentBinding) {
        return current;
      }
      this.binding = next;
      this.emit();
      return next;
    });
  }

  async unpair(): Promise<void> {
    this.unpairing = true;
    let remoteError: unknown;
    try {
      if (this.stateValue.connection === "connected") {
        const handle = await this.sendCommand("security.unpair", {
          commandId: await this.options.entropy.randomId("unpair"),
        });
        await handle.completion;
      }
    } catch (error) {
      remoteError = error;
    }
    try {
      await this.revokeLocal("revoked");
    } catch (cleanupError) {
      throw cleanupError;
    }
    if (remoteError) {
      throw remoteError;
    }
  }

  async revokeLocal(reason: "revoked" | "replaced" | "disabled" | "identity_reset" = "revoked"): Promise<void> {
    const activeBinding = this.binding;
    const revoked: RemoteBindingV1 = { ...activeBinding, status: "revoked" };
    this.binding = revoked;
    this.invalidateConnection(4001, reason);
    const cleanupErrors: unknown[] = [];
    await attemptCleanup(() => this.runBindingMutation(() => this.options.bindingStore.write(revoked)), cleanupErrors);
    if (activeBinding.workspaceBindingId) {
      await attemptCleanup(() => this.options.cacheStore.remove(activeBinding.workspaceBindingId!), cleanupErrors);
    }
    await attemptCleanup(() => this.options.keys.delete(activeBinding.deviceKeyId), cleanupErrors);
    await attemptCleanup(() => this.runBindingMutation(() => this.options.bindingStore.remove()), cleanupErrors);
    this.dispatch({ type: "clear_workspace" });
    this.dispatch({ type: "connection", status: "revoked" });
    if (cleanupErrors.length > 0) {
      throw new Error("remote_local_revoke_incomplete");
    }
  }

  private async openAuthenticatedSession(generation: number): Promise<void> {
    this.assertConnectionGeneration(generation);
    this.intentionalClose = false;
    this.dispatch({
      type: "connection",
      status: this.reconnectAttempts > 0 ? "reconnecting" : "connecting",
    });
    const attempt = new AbortController();
    this.authenticationAttempt = attempt;
    try {
      const { channel, authentication } = await openRemoteSessionChannel(this.options, this.authenticationContext(generation), attempt.signal);
      await this.runSession(generation, channel, authentication);
    } finally {
      if (this.authenticationAttempt === attempt) this.authenticationAttempt = undefined;
    }
  }

  private async runSession(
    generation: number,
    socket: RemoteMessageChannel,
    authentication: RemoteSessionAuthentication,
  ): Promise<void> {
    if (!this.isConnectionActive(generation)) {
      socket.close(1000, "stale_connection");
      throw new Error("remote_connection_invalidated");
    }
    this.clientSeq = 0;
    this.streamSequences.clear();
    this.streamSnapshots.clear();
    this.controlStreamId = undefined;
    this.socket = socket;
    this.expectedSessionId = "proof" in authentication ? authentication.proof.candidateSessionId : undefined;
    let challengeRoute = "route" in authentication ? authentication.route : undefined;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.detachSocket = socket.subscribe({
      opened: () => {
        if (!this.isCurrentSocket(generation, socket) || !("proof" in authentication)) return;
        try {
          socket.send(JSON.stringify(authentication.proof));
        } catch (error) {
          this.failSession(error, generation, socket);
        }
      },
      received: raw => {
        if (!this.isCurrentSocket(generation, socket)) return;
        this.frameQueue = this.frameQueue
          .then(async () => {
            if (!challengeRoute) return await this.handleRawFrame(raw, generation, socket);
            this.assertCurrentSocket(generation, socket);
            if (typeof raw !== "string") throw new Error("remote_binary_frame_not_supported");
            const route = challengeRoute;
            challengeRoute = undefined;
            const proof = await createRemoteSessionProof(this.authenticationContext(generation), parseRemoteAuthFrameV1(raw), route);
            this.assertCurrentSocket(generation, socket);
            this.expectedSessionId = proof.candidateSessionId;
            socket.send(JSON.stringify(proof));
          })
          .catch(error => this.failSession(error, generation, socket));
      },
      failed: () => this.failSession(new Error("remote_socket_error"), generation, socket),
      closed: event => {
        this.frameQueue = this.frameQueue.then(() => this.handleClose(event.code, event.reason, generation, socket));
      },
    });
    const timeout = setTimeout(() => this.failSession(new Error("remote_session_ready_timeout"), generation, socket), 10_000);
    try {
      await ready;
      this.assertConnectionActive(generation);
      this.reconnectAttempts = 0;
    } finally {
      clearTimeout(timeout);
      if (this.connectionGeneration === generation) {
        this.readyResolve = undefined;
        this.readyReject = undefined;
      }
    }
  }

  private authenticationContext(generation: number) {
    return {
      binding: this.binding,
      keys: this.options.keys,
      entropy: this.options.entropy,
      clock: this.options.clock,
      assertCurrent: () => this.assertConnectionActive(generation),
      readResumeCursors: () => this.readResumeCursors(),
    };
  }

  private async handleRawFrame(raw: unknown, generation: number, socket: RemoteMessageChannel): Promise<void> {
    this.assertCurrentSocket(generation, socket);
    if (typeof raw !== "string") {
      throw new Error("remote_binary_frame_not_supported");
    }
    const frame = parseRemoteServerFrameV1(raw);
    if (frame.gatewayId !== this.binding.gatewayId) {
      throw new Error("remote_gateway_pin_mismatch");
    }
    if (this.currentSessionId && frame.sessionId !== this.currentSessionId) {
      throw new Error("remote_session_identity_mismatch");
    }
    if (!this.currentSessionId) {
      if (frame.type !== "session.ready" || frame.sessionId !== this.expectedSessionId) {
        throw new Error("remote_session_ready_required");
      }
      this.currentSessionId = frame.sessionId;
    }
    const previousSeq = this.streamSequences.get(frame.streamId) ?? 0;
    if (frame.serverSeq <= previousSeq) {
      await this.sendAck(frame.streamId, previousSeq, generation, socket);
      this.assertCurrentSocket(generation, socket);
      return;
    }
    if (frame.serverSeq !== previousSeq + 1) {
      if (this.deviceJournalWatches.size > 0 && frame.streamId === this.controlStreamId) {
        throw new Error("remote_device_journal_stream_gap");
      }
      this.streamSequences.set(frame.streamId, frame.serverSeq);
      await this.requestFullResync();
      this.assertCurrentSocket(generation, socket);
      return;
    }
    this.streamSequences.set(frame.streamId, frame.serverSeq);
    await this.applyFrame(frame, generation, socket);
    this.assertCurrentSocket(generation, socket);
    await this.sendAck(frame.streamId, frame.serverSeq, generation, socket);
    this.assertCurrentSocket(generation, socket);
    await this.persistCache();
    this.assertCurrentSocket(generation, socket);
  }

  private async applyFrame(frame: RemoteServerFrameV1, generation: number, socket: RemoteMessageChannel): Promise<void> {
    switch (frame.type) {
      case "session.ready": {
        if (frame.sessionId === "" || frame.payload.deviceId !== this.binding.deviceId) {
          throw new Error("remote_session_identity_mismatch");
        }
        this.controlStreamId = frame.streamId;
        await this.activateWorkspaceBinding(frame.payload.policy.workspaceBindingId, generation, socket);
        this.dispatch({ type: "session_ready", policy: frame.payload.policy });
        this.readyResolve?.();
        const handle = await this.sendCommand("stream.subscribe", {
          commandId: await this.options.entropy.randomId("subscribe"),
          scope: { kind: "workspace", workspaceId: frame.payload.policy.workspaceId },
        });
        void handle.completion.catch(() => undefined);
        return;
      }
      case "workspace.summary":
        this.dispatch({ type: "workspace", workspace: frame.payload });
        return;
      case "conversation.list_snapshot":
        this.dispatch({ type: "conversation_list", snapshot: frame.payload });
        return;
      case "conversation.snapshot": {
        this.streamSnapshots.set(frame.streamId, frame.payload.snapshotId);
        const outbound = frame.requestId ? this.outboundByMessage.get(frame.requestId) : undefined;
        const appendOlder = outbound?.type === "conversation.open"
          && Boolean((outbound.payload as RemoteConversationOpenCommandV1).olderPageCursor);
        this.dispatch({ type: "conversation_snapshot", snapshot: frame.payload, appendOlder });
        if (frame.requestId) {
          this.outboundByMessage.delete(frame.requestId);
        }
        return;
      }
      case "conversation.delta":
        this.dispatch({ type: "conversation_delta", delta: frame.payload });
        return;
      case "profile.snapshot":
        this.dispatch({ type: "profile", profile: frame.payload });
        return;
      case "device.list_snapshot":
        this.assertDeviceWorkspace(frame.payload.workspaceId);
        this.dispatch({ type: "device_overview", snapshot: frame.payload });
        return;
      case "device.task.snapshot":
        this.assertDeviceWorkspace(frame.payload.workspaceId);
        this.dispatch({ type: "device_task", snapshot: frame.payload });
        return;
      case "device.task.journal_page":
        if (frame.streamId !== this.controlStreamId) throw new Error("remote_device_journal_stream_mismatch");
        this.applyDeviceJournalWatchPage(frame.payload.watchId, frame.payload.journal, false);
        return;
      case "command.accepted":
        if (frame.payload.commandType === "conversation.send_text") {
          this.dispatch({ type: "send_accepted", commandId: frame.payload.commandId });
        }
        return;
      case "command.completed":
        if (frame.payload.commandType === "device.collaboration") {
          const pending = this.commands.get(frame.payload.commandId);
          if (frame.streamId !== this.controlStreamId || (pending
            && (pending.type !== frame.payload.commandType || pending.messageId !== frame.requestId))) {
            throw new Error("remote_device_collaboration_command_mismatch");
          }
        }
        if (frame.payload.commandType === "device.task.journal.watch" && frame.payload.result.kind === "device_task_journal_watching") {
          const pending = this.commands.get(frame.payload.commandId);
          if (frame.streamId !== this.controlStreamId || (pending && pending.type !== frame.payload.commandType)) {
            throw new Error("remote_device_journal_stream_mismatch");
          }
          this.applyDeviceJournalWatchPage(frame.payload.commandId, frame.payload.result.journal, true);
        }
        this.completeCommand(frame.payload.commandId, frame.payload.result);
        if (frame.payload.commandType === "conversation.send_text") {
          this.dispatch({
            type: "send_completed",
            commandId: frame.payload.commandId,
            messageId: frame.payload.result.messageId,
          });
        }
        return;
      case "command.failed":
        this.failCommand(frame.payload);
        return;
      case "stream.resync_required":
      case "workspace.binding_changed":
        await this.requestFullResync();
        return;
      case "security.revoked":
        if (frame.payload.reason === "replaced") {
          this.disconnect();
          return;
        }
        await this.revokeLocal(frame.payload.reason);
        return;
    }
  }

  private async sendCommand<T extends CommandType>(
    type: T,
    payload: RemoteClientCommandPayloadMapV1[T],
    assertAuthority?: () => void,
  ): Promise<RemoteCommandHandle<RemoteCommandResultMapV1[T]>> {
    this.requireConnectedSocket();
    const messageId = await this.options.entropy.randomId("message");
    this.requireConnectedSocket();
    assertAuthority?.();
    const completion = new Promise<RemoteCommandResultMapV1[T]>((resolve, reject) => {
      const pending: PendingCommand<RemoteCommandResultMapV1[T]> = {
        commandId: payload.commandId,
        messageId,
        type,
        payload: payload as RemoteClientCommandPayloadMapV1[CommandType],
        resolve,
        reject,
      };
      this.commands.set(payload.commandId, pending as PendingCommand);
      this.outboundByMessage.set(messageId, pending as PendingCommand);
    });
    this.sendFrame(type, payload, messageId);
    return { commandId: payload.commandId, completion };
  }

  private async sendAck(streamId: string, ackServerSeq: number, generation: number, socket: RemoteMessageChannel): Promise<void> {
    const messageId = await this.options.entropy.randomId("ack");
    this.assertCurrentSocket(generation, socket);
    this.sendFrame("stream.ack", { streamId, ackServerSeq }, messageId);
  }

  private sendFrame<T extends RemoteClientCommandTypeV1>(
    type: T,
    payload: RemoteClientCommandPayloadMapV1[T],
    messageId: string,
  ): void {
    const socket = this.requireConnectedSocket();
    const sentAt = this.options.clock.now();
    this.clientSeq += 1;
    const frame: RemoteClientFrameV1 = {
      version: REMOTE_PROTOCOL_VERSION,
      type,
      messageId,
      gatewayId: this.binding.gatewayId,
      sessionId: this.requireSessionId(),
      sentAt,
      payload,
      clientSeq: this.clientSeq,
      expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    } as RemoteClientFrameV1;
    socket.send(JSON.stringify(frame));
  }

  private completeCommand(commandId: string, result: unknown): void {
    const pending = this.commands.get(commandId);
    if (!pending) {
      return;
    }
    this.commands.delete(commandId);
    if (pending.type !== "conversation.open") this.outboundByMessage.delete(pending.messageId);
    pending.resolve(result);
  }

  private failCommand(failed: RemoteCommandFailedV1): void {
    const pending = this.commands.get(failed.commandId);
    if (pending) {
      this.commands.delete(failed.commandId);
      this.outboundByMessage.delete(pending.messageId);
      pending.reject(new Error(`${failed.error.code}: ${failed.error.message}`));
    }
    if (failed.commandType === "conversation.send_text") {
      this.dispatch({ type: "send_failed", commandId: failed.commandId, error: failed.error });
    }
  }

  private async activateWorkspaceBinding(
    workspaceBindingId: string,
    generation: number,
    socket: RemoteMessageChannel,
  ): Promise<void> {
    await this.runBindingMutation(async () => {
      this.assertCurrentSocket(generation, socket);
      const previous = this.binding.workspaceBindingId;
      if (previous && previous !== workspaceBindingId) {
        await this.options.cacheStore.remove(previous);
        this.assertCurrentSocket(generation, socket);
        this.dispatch({ type: "clear_workspace", workspaceBindingId });
      }
      const { lingServerRoutingProfile, ...binding } = this.binding;
      const nextBinding = {
        ...binding, workspaceBindingId,
        ...(previous === workspaceBindingId && lingServerRoutingProfile ? { lingServerRoutingProfile } : {}),
      };
      this.assertCurrentSocket(generation, socket);
      await this.options.bindingStore.write(nextBinding);
      this.assertCurrentSocket(generation, socket);
      this.binding = nextBinding;
    });
    const cache = await this.options.cacheStore.read(workspaceBindingId);
    this.assertCurrentSocket(generation, socket);
    if (cache?.workspaceBindingId === workspaceBindingId) {
      this.stateValue = { ...cache.state, connection: "connecting", deviceOverviewCurrent: false, deviceTaskCurrent: false, lastError: undefined };
      this.emit();
    }
  }

  private async persistCache(): Promise<void> {
    const workspaceBindingId = this.binding.workspaceBindingId;
    if (!workspaceBindingId || this.binding.status !== "active") {
      return;
    }
    const { deviceTask } = this.stateValue;
    let state = { ...this.stateValue, deviceOverviewCurrent: false, deviceTaskCurrent: false };
    if (deviceTask?.task.pendingApproval) {
      const { pendingApproval: _pendingApproval, ...task } = deviceTask.task;
      state = { ...state, deviceTask: { ...deviceTask, task } };
    }
    await this.options.cacheStore.write(workspaceBindingId, {
      version: 1,
      workspaceBindingId,
      state,
      resume: this.resumeCursors(),
      updatedAt: this.options.clock.now(),
    });
  }

  private async readResumeCursors(): Promise<readonly RemoteResumeCursorV1[]> {
    if (!this.binding.workspaceBindingId) {
      return [];
    }
    return (await this.options.cacheStore.read(this.binding.workspaceBindingId))?.resume ?? [];
  }

  private resumeCursors(): readonly RemoteResumeCursorV1[] {
    return [...this.streamSnapshots.entries()].flatMap(([streamId, snapshotId]) => {
      const lastAckServerSeq = this.streamSequences.get(streamId);
      return lastAckServerSeq === undefined ? [] : [{ streamId, snapshotId, lastAckServerSeq, hasMaterializedSnapshot: true as const }];
    });
  }

  private dispatch(action: RemoteStateAction): void {
    this.stateValue = reduceRemoteClientState(this.stateValue, action);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.stateValue);
    }
  }

  private requireWorkspaceId(): string {
    const workspaceId = this.stateValue.policy?.workspaceId;
    if (!workspaceId) {
      throw new Error("remote_session_not_ready");
    }
    return workspaceId;
  }

  private requireDeviceWorkspaceId(): string {
    if (!this.stateValue.policy?.capabilities.includes("device.read")) throw new Error("remote_device_read_unavailable");
    return this.requireWorkspaceId();
  }

  private assertDeviceWorkspace(workspaceId: string): void {
    if (workspaceId !== this.requireDeviceWorkspaceId()) throw new Error("remote_device_workspace_mismatch");
  }

  private deviceTaskAuthority(capability: "device.approve" | "device.revoke" | "device.reconcile" | "device.journal" | "device.journal.watch") {
    const sessionId = this.requireSessionId();
    const workspaceId = this.requireDeviceWorkspaceId();
    const assertCurrent = () => {
      if (this.requireSessionId() !== sessionId || this.requireDeviceWorkspaceId() !== workspaceId
        || !this.stateValue.policy?.capabilities.includes(capability)) {
        throw new Error(capability.startsWith("device.journal") ? "remote_device_journal_unavailable" : "remote_device_mutation_unavailable");
      }
    };
    assertCurrent();
    return { workspaceId, assertCurrent };
  }

  private requireSessionId(): string {
    const socketSession = this.stateValue.connection === "connected" ? this.currentSessionId : undefined;
    if (!socketSession) {
      throw new Error("remote_session_not_ready");
    }
    return socketSession;
  }

  private currentSessionId?: string;
  private controlStreamId?: string;

  private requireConnectedSocket(): RemoteMessageChannel {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("remote_socket_not_connected");
    }
    return this.socket;
  }

  private failSession(error: unknown, generation: number, socket: RemoteMessageChannel): void {
    if (!this.isCurrentSocket(generation, socket)) {
      return;
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.readyReject?.(normalized);
    socket.close(1011, normalized.message.slice(0, 100));
    this.dispatch({ type: "connection", status: "disconnected", error: normalized.message });
  }

  private handleClose(code: number | undefined, reason: string | undefined, generation: number, socket: RemoteMessageChannel): void {
    if (!this.isCurrentSocket(generation, socket)) {
      return;
    }
    const closeMessage = reason || `remote_socket_closed_${code ?? 0}`;
    this.readyReject?.(new Error(closeMessage));
    this.detachSocket?.();
    this.detachSocket = undefined;
    this.socket = undefined;
    this.currentSessionId = undefined;
    this.expectedSessionId = undefined;
    this.rejectPendingCommands(closeMessage);
    if (this.intentionalClose || this.binding.status !== "active") {
      return;
    }
    this.dispatch({ type: "connection", status: "reconnecting", error: closeMessage });
    this.scheduleReconnect();
  }

  private rejectPendingCommands(message: string): void {
    const watches = [...this.deviceJournalWatches.values()];
    this.deviceJournalWatches.clear();
    for (const watch of watches) watch.onError?.(new Error(message));
    for (const pending of this.commands.values()) {
      pending.reject(new Error(message));
      if (pending.type === "conversation.send_text") {
        this.dispatch({
          type: "send_failed",
          commandId: pending.commandId,
          error: { code: "pc_unavailable", message, retryable: true },
        });
      }
    }
    this.commands.clear();
    this.outboundByMessage.clear();
  }

  private scheduleReconnect(): void {
    if (this.options.autoReconnect === false || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 15_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async runBindingMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.bindingMutation.then(operation, operation);
    this.bindingMutation = result.then(() => undefined, () => undefined);
    return await result;
  }

  private invalidateConnection(code: number, reason: string): void {
    this.connectionGeneration += 1;
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.readyReject?.(new Error("remote_connection_invalidated"));
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.authenticationAttempt?.abort();
    this.authenticationAttempt = undefined;
    this.detachSocket?.();
    this.detachSocket = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.currentSessionId = undefined;
    this.expectedSessionId = undefined;
    this.connectPromise = undefined;
    this.rejectPendingCommands(reason);
    socket?.close(code, reason);
  }

  private isConnectionActive(generation: number): boolean {
    return this.connectionGeneration === generation
      && this.binding.status === "active"
      && !this.intentionalClose;
  }

  private isCurrentSocket(generation: number, socket: RemoteMessageChannel): boolean {
    return this.isConnectionActive(generation) && this.socket === socket;
  }

  private assertCurrentSocket(generation: number, socket: RemoteMessageChannel): void {
    if (!this.isCurrentSocket(generation, socket)) {
      throw new Error("remote_connection_invalidated");
    }
  }

  private assertConnectionGeneration(generation: number): void {
    if (this.connectionGeneration !== generation || this.binding.status !== "active") {
      throw new Error("remote_connection_invalidated");
    }
  }

  private assertConnectionActive(generation: number): void {
    if (!this.isConnectionActive(generation)) {
      throw new Error("remote_connection_invalidated");
    }
  }
}

function normalizeDeviceJournalCursor(cursor: Omit<DeviceJournalCursor, "limit"> & { readonly limit?: number }): DeviceJournalCursor {
  const { generation, afterSequence, limit = REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1 } = cursor;
  if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(afterSequence) || afterSequence < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1) {
    throw new Error("remote_device_journal_invalid_cursor");
  }
  return { generation, afterSequence, limit };
}

function assertDeviceJournalPage(page: RemoteDeviceTaskJournalV1, workspaceId: string, taskId: string, cursor: DeviceJournalCursor): void {
  if (page.workspaceId !== workspaceId || page.task.taskId !== taskId || page.afterSequence !== cursor.afterSequence
    || page.events.length > cursor.limit
    || page.requiresSnapshot !== (page.generation !== cursor.generation || cursor.afterSequence > page.latestSequence)) {
    throw new Error("remote_device_journal_binding_mismatch");
  }
}

async function attemptCleanup(operation: () => Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}
