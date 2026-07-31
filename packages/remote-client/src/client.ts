import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteAuthChallengeV1,
  type RemoteAuthProofV1,
  type RemoteClientCommandPayloadMapV1,
  type RemoteClientCommandTypeV1,
  type RemoteClientFrameV1,
  type RemoteCommandFailedV1,
  type RemoteCommandResultMapV1,
  type RemoteConversationOpenCommandV1,
  type RemoteMarkConversationReadCommandV1,
  type RemoteProfileUpdateCommandV1,
  type RemoteResumeCursorV1,
  type RemoteSendTextCommandV1,
  type RemoteServerFrameV1,
} from "@ling-stack/contracts";
import {
  authChallengeSigningBytes,
  authChallengeSigningInput,
  authProofSigningBytes,
  authProofSigningInput,
  encodeBase64Url,
  parseRemoteServerFrameV1,
  sha256,
  validateRemoteAuthChallengeV1,
} from "@ling-stack/remote-protocol";
import {
  createInitialRemoteClientState,
  reduceRemoteClientState,
  type RemoteClientState,
  type RemotePendingSend,
  type RemoteStateAction,
} from "./state.js";
import {
  remoteWebSocketUrl,
  type RemoteBindingStore,
  type RemoteBindingV1,
  type RemoteCacheStore,
  type RemoteClock,
  type RemoteDeviceKeyAdapter,
  type RemoteEntropy,
  type RemoteHttpClient,
  type RemoteWebSocketFactory,
  type RemoteWebSocketLike,
} from "./types.js";

type CommandType = Exclude<RemoteClientCommandTypeV1, "stream.ack">;

export interface RemoteCommandHandle<TResult> {
  readonly commandId: string;
  readonly completion: Promise<TResult>;
}

interface PendingCommand<TResult = unknown> {
  readonly commandId: string;
  readonly messageId: string;
  readonly type: CommandType;
  readonly payload: RemoteClientCommandPayloadMapV1[CommandType];
  readonly resolve: (result: TResult) => void;
  readonly reject: (error: Error) => void;
}

export interface RemoteSessionClientOptions {
  readonly binding: RemoteBindingV1;
  readonly bindingStore: RemoteBindingStore;
  readonly cacheStore: RemoteCacheStore<RemoteClientState>;
  readonly http: RemoteHttpClient;
  readonly keys: RemoteDeviceKeyAdapter;
  readonly entropy: RemoteEntropy;
  readonly clock: RemoteClock;
  readonly webSocketFactory: RemoteWebSocketFactory;
  readonly autoReconnect?: boolean;
}

export class RemoteSessionClient {
  private binding: RemoteBindingV1;
  private stateValue = createInitialRemoteClientState();
  private readonly listeners = new Set<(state: RemoteClientState) => void>();
  private readonly commands = new Map<string, PendingCommand>();
  private readonly outboundByMessage = new Map<string, PendingCommand>();
  private readonly streamSequences = new Map<string, number>();
  private readonly streamSnapshots = new Map<string, string>();
  private socket?: RemoteWebSocketLike;
  private connectPromise?: Promise<void>;
  private frameQueue = Promise.resolve();
  private clientSeq = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionalClose = false;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;

  constructor(private readonly options: RemoteSessionClientOptions) {
    this.binding = options.binding;
  }

  get state(): RemoteClientState {
    return this.stateValue;
  }

  subscribe(listener: (state: RemoteClientState) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.binding.status !== "active") {
      throw new Error("remote_binding_revoked");
    }
    if (this.stateValue.connection === "connected") {
      return;
    }
    this.connectPromise ??= this.openAuthenticatedSession().finally(() => {
      this.connectPromise = undefined;
    });
    return await this.connectPromise;
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.socket?.close(1000, "client_disconnect");
    this.socket = undefined;
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

  async requestFullResync(): Promise<void> {
    const handle = await this.sendCommand("snapshot.request", {
      commandId: await this.options.entropy.randomId("snapshot"),
      scope: { kind: "workspace", workspaceId: this.requireWorkspaceId() },
    });
    void handle.completion.catch(() => undefined);
  }

  async revokeLocal(reason: "revoked" | "replaced" | "disabled" | "identity_reset" = "revoked"): Promise<void> {
    const activeBinding = this.binding;
    const revoked: RemoteBindingV1 = { ...activeBinding, status: "revoked" };
    await this.options.bindingStore.write(revoked);
    this.binding = revoked;
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.socket?.close(4001, reason);
    this.socket = undefined;
    if (activeBinding.workspaceBindingId) {
      await this.options.cacheStore.remove(activeBinding.workspaceBindingId);
    }
    await this.options.keys.delete(activeBinding.deviceKeyId);
    await this.options.bindingStore.remove();
    this.dispatch({ type: "clear_workspace" });
    this.dispatch({ type: "connection", status: "revoked" });
  }

  private async openAuthenticatedSession(): Promise<void> {
    this.intentionalClose = false;
    this.dispatch({
      type: "connection",
      status: this.reconnectAttempts > 0 ? "reconnecting" : "connecting",
    });
    const proof = await this.createAuthProof();
    this.clientSeq = 0;
    this.streamSequences.clear();
    this.streamSnapshots.clear();
    const socket = this.options.webSocketFactory(remoteWebSocketUrl(this.binding.gatewayOrigin));
    this.socket = socket;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    socket.addEventListener("open", () => socket.send(JSON.stringify(proof)));
    socket.addEventListener("message", (event) => {
      this.frameQueue = this.frameQueue
        .then(async () => await this.handleRawFrame(event.data))
        .catch((error) => this.failSession(error));
    });
    socket.addEventListener("error", () => this.failSession(new Error("remote_socket_error")));
    socket.addEventListener("close", (event) => this.handleClose(event.code, event.reason));
    const timeout = setTimeout(() => this.failSession(new Error("remote_session_ready_timeout")), 10_000);
    try {
      await ready;
      this.reconnectAttempts = 0;
    } finally {
      clearTimeout(timeout);
      this.readyResolve = undefined;
      this.readyReject = undefined;
    }
  }

  private async createAuthProof(): Promise<RemoteAuthProofV1> {
    const response = await this.options.http.postJson<unknown>(this.binding.gatewayOrigin, "/v1/auth/challenge", {
      deviceId: this.binding.deviceId,
    });
    const challenge: RemoteAuthChallengeV1 = validateRemoteAuthChallengeV1(response.body, {
      nowMs: Date.parse(this.options.clock.now()),
    });
    if (
      challenge.gatewayId !== this.binding.gatewayId
      || challenge.deviceEpoch !== this.binding.deviceEpoch
      || !challenge.supportedProtocolVersions.includes(REMOTE_PROTOCOL_VERSION)
    ) {
      throw new Error("remote_auth_challenge_identity_mismatch");
    }
    const { gatewaySignature: _gatewaySignature, ...unsignedChallenge } = challenge;
    const challengeValid = await this.options.keys.verify(
      this.binding.gatewayIdentityPublicKeyJwk,
      authChallengeSigningBytes(authChallengeSigningInput(this.binding.gatewayOrigin, unsignedChallenge)),
      challenge.gatewaySignature,
    );
    if (!challengeValid) {
      throw new Error("remote_auth_gateway_signature_invalid");
    }
    const resume = await this.readResumeCursors();
    const unsignedProof: Omit<RemoteAuthProofV1, "signature"> = {
      version: REMOTE_PROTOCOL_VERSION,
      gatewayId: this.binding.gatewayId,
      challengeId: challenge.challengeId,
      candidateSessionId: challenge.candidateSessionId,
      deviceId: this.binding.deviceId,
      deviceEpoch: this.binding.deviceEpoch,
      clientNonce: encodeBase64Url(await this.options.entropy.randomBytes(32)),
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      resume,
    };
    const signingInput = await authProofSigningInput(
      this.binding.gatewayOrigin,
      unsignedChallenge,
      unsignedProof,
      sha256,
    );
    return {
      ...unsignedProof,
      signature: await this.options.keys.sign(this.binding.deviceKeyId, authProofSigningBytes(signingInput)),
    };
  }

  private async handleRawFrame(raw: unknown): Promise<void> {
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
      if (frame.type !== "session.ready") {
        throw new Error("remote_session_ready_required");
      }
      this.currentSessionId = frame.sessionId;
    }
    const previousSeq = this.streamSequences.get(frame.streamId) ?? 0;
    if (frame.serverSeq <= previousSeq) {
      await this.sendAck(frame.streamId, previousSeq);
      return;
    }
    if (frame.serverSeq !== previousSeq + 1) {
      this.streamSequences.set(frame.streamId, frame.serverSeq);
      await this.requestFullResync();
      return;
    }
    this.streamSequences.set(frame.streamId, frame.serverSeq);
    await this.applyFrame(frame);
    await this.sendAck(frame.streamId, frame.serverSeq);
    await this.persistCache();
  }

  private async applyFrame(frame: RemoteServerFrameV1): Promise<void> {
    switch (frame.type) {
      case "session.ready": {
        if (frame.sessionId === "" || frame.payload.deviceId !== this.binding.deviceId) {
          throw new Error("remote_session_identity_mismatch");
        }
        await this.activateWorkspaceBinding(frame.payload.policy.workspaceBindingId);
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
      case "command.accepted":
        if (frame.payload.commandType === "conversation.send_text") {
          this.dispatch({ type: "send_accepted", commandId: frame.payload.commandId });
        }
        return;
      case "command.completed":
        this.completeCommand(frame.payload.commandId, frame.payload.result);
        if (frame.payload.commandType === "conversation.send_text") {
          this.dispatch({ type: "send_completed", commandId: frame.payload.commandId });
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
        await this.revokeLocal(frame.payload.reason);
        return;
    }
  }

  private async sendCommand<T extends CommandType>(
    type: T,
    payload: RemoteClientCommandPayloadMapV1[T],
  ): Promise<RemoteCommandHandle<RemoteCommandResultMapV1[T]>> {
    this.requireConnectedSocket();
    const messageId = await this.options.entropy.randomId("message");
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

  private async sendAck(streamId: string, ackServerSeq: number): Promise<void> {
    this.sendFrame("stream.ack", { streamId, ackServerSeq }, await this.options.entropy.randomId("ack"));
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
    pending.resolve(result);
  }

  private failCommand(failed: RemoteCommandFailedV1): void {
    const pending = this.commands.get(failed.commandId);
    if (pending) {
      this.commands.delete(failed.commandId);
      pending.reject(new Error(`${failed.error.code}: ${failed.error.message}`));
    }
    if (failed.commandType === "conversation.send_text") {
      this.dispatch({ type: "send_failed", commandId: failed.commandId, error: failed.error });
    }
  }

  private async activateWorkspaceBinding(workspaceBindingId: string): Promise<void> {
    const previous = this.binding.workspaceBindingId;
    if (previous && previous !== workspaceBindingId) {
      await this.options.cacheStore.remove(previous);
      this.dispatch({ type: "clear_workspace", workspaceBindingId });
    }
    this.binding = { ...this.binding, workspaceBindingId };
    await this.options.bindingStore.write(this.binding);
    const cache = await this.options.cacheStore.read(workspaceBindingId);
    if (cache?.workspaceBindingId === workspaceBindingId) {
      this.stateValue = { ...cache.state, connection: "connecting", lastError: undefined };
      this.emit();
    }
  }

  private async persistCache(): Promise<void> {
    const workspaceBindingId = this.binding.workspaceBindingId;
    if (!workspaceBindingId || this.binding.status !== "active") {
      return;
    }
    await this.options.cacheStore.write(workspaceBindingId, {
      version: 1,
      workspaceBindingId,
      state: this.stateValue,
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

  private requireSessionId(): string {
    const socketSession = this.stateValue.connection === "connected" ? this.currentSessionId : undefined;
    if (!socketSession) {
      throw new Error("remote_session_not_ready");
    }
    return socketSession;
  }

  private currentSessionId?: string;

  private requireConnectedSocket(): RemoteWebSocketLike {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("remote_socket_not_connected");
    }
    return this.socket;
  }

  private failSession(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.readyReject?.(normalized);
    this.socket?.close(1011, normalized.message.slice(0, 100));
    this.dispatch({ type: "connection", status: "disconnected", error: normalized.message });
  }

  private handleClose(code?: number, reason?: string): void {
    this.socket = undefined;
    this.currentSessionId = undefined;
    this.rejectPendingCommands(reason || `remote_socket_closed_${code ?? 0}`);
    if (this.intentionalClose || this.binding.status !== "active") {
      return;
    }
    this.dispatch({ type: "connection", status: "reconnecting", error: reason || `remote_socket_closed_${code ?? 0}` });
    this.scheduleReconnect();
  }

  private rejectPendingCommands(message: string): void {
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
}
