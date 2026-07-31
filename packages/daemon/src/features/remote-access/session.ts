import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteAccessPolicySummaryV1,
  type RemoteClientFrameV1,
  type RemoteCommandCompletedV1,
  type RemoteCommandFailedV1,
  type RemoteCommandResultMapV1,
  type RemoteConversationDeltaV1,
  type RemoteLifecycleCommandTypeV1,
  type RemoteServerEventPayloadMapV1,
  type RemoteServerEventTypeV1,
  type RemoteServerFrameV1,
  type RemoteStreamScopeV1,
} from "@ling-stack/contracts";
import {
  commandHashBytes,
  commandHashInput,
  encodeBase64Url,
  evaluateClientSequenceV1,
  evaluateCumulativeAckV1,
  isRemoteProtocolError,
  parseRemoteClientFrameV1,
  sha256,
} from "@ling-stack/remote-protocol";
import type { RemoteConversationFacade, RemoteProjectedEvent } from "./conversation-facade.js";
import { RemoteAccessError } from "./errors.js";
import type { AuthenticatedRemoteSession } from "./pairing-auth-service.js";

const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_COMMANDS_PER_MINUTE = 120;

interface RemoteStreamState {
  readonly id: string;
  readonly scope: RemoteStreamScopeV1;
  snapshotId: string;
  serverSeq: number;
  ackServerSeq: number;
}

export interface RemoteGatewaySessionOptions {
  readonly socket: WebSocket;
  readonly authenticated: AuthenticatedRemoteSession;
  readonly gatewayId: string;
  readonly facade: RemoteConversationFacade;
  readonly policy: RemoteAccessPolicySummaryV1;
  readonly now?: () => string;
  readonly onMutation?: () => void;
  readonly onSelfUnpair?: () => void;
  readonly onClosed?: (session: RemoteGatewaySession) => void;
}

export class RemoteGatewaySession {
  readonly sessionId: string;
  readonly deviceId: string;
  private readonly now: () => string;
  private readonly controlStream: RemoteStreamState;
  private readonly streams = new Map<string, RemoteStreamState>();
  private lastClientSeq = 0;
  private commandWindowStartedAt = 0;
  private commandCount = 0;
  private closed = false;
  private messageQueue = Promise.resolve();

  constructor(private readonly options: RemoteGatewaySessionOptions) {
    this.sessionId = options.authenticated.sessionId;
    this.deviceId = options.authenticated.device.deviceId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.controlStream = {
      id: `control_${this.sessionId}`,
      scope: { kind: "workspace", workspaceId: options.policy.workspaceId },
      snapshotId: `control_snapshot_${this.sessionId}`,
      serverSeq: 0,
      ackServerSeq: 0,
    };
    this.streams.set(this.controlStream.id, this.controlStream);
    options.socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.closePolicyViolation("Binary frames are not supported.");
        return;
      }
      this.messageQueue = this.messageQueue
        .then(async () => await this.handleRawFrame(data.toString()))
        .catch(() => this.closePolicyViolation("Remote command processing failed."));
    });
    options.socket.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        options.onClosed?.(this);
      }
    });
    options.socket.on("error", () => {
      this.close(1011, "Remote session transport failed.");
    });
    this.sendEvent("session.ready", {
      deviceId: this.deviceId,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      policy: options.policy,
      connectedAt: options.authenticated.authenticatedAt,
    }, this.controlStream);
  }

  publish(event: RemoteProjectedEvent): void {
    if (this.closed) {
      return;
    }
    for (const stream of this.streams.values()) {
      if (stream === this.controlStream) {
        continue;
      }
      if (event.type === "profile.snapshot") {
        if (stream.scope.kind === "workspace") {
          this.sendEvent(event.type, event.payload, stream);
        }
        continue;
      }
      const conversationId = deltaConversationId(event.payload);
      if (
        stream.scope.kind === "workspace"
        || (stream.scope.kind === "conversation" && stream.scope.conversationId === conversationId)
      ) {
        this.sendEvent(event.type, event.payload, stream);
      }
    }
  }

  revoke(reason: "revoked" | "replaced" | "disabled" | "identity_reset"): void {
    if (this.closed) {
      return;
    }
    this.sendEvent("security.revoked", { reason, revokedAt: this.now() }, this.controlStream);
    this.close(4001, reason);
  }

  private async handleRawFrame(raw: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.consumeRateLimit();
    let frame: RemoteClientFrameV1;
    try {
      frame = parseRemoteClientFrameV1(raw, { nowMs: Date.parse(this.now()) });
    } catch (error) {
      this.closePolicyViolation(isRemoteProtocolError(error) ? `${error.code}: ${error.message}` : "Invalid remote frame.");
      return;
    }
    if (frame.gatewayId !== this.options.gatewayId || frame.sessionId !== this.sessionId) {
      this.closePolicyViolation("Frame authority does not match this session.");
      return;
    }
    const sequenceDecision = evaluateClientSequenceV1(this.lastClientSeq, frame.clientSeq);
    if (sequenceDecision.kind !== "accept") {
      this.closePolicyViolation(`Client sequence invalid; expected ${sequenceDecision.expected}.`);
      return;
    }
    this.lastClientSeq = sequenceDecision.next;
    if (frame.type === "stream.ack") {
      this.handleAck(frame.payload.streamId, frame.payload.ackServerSeq);
      return;
    }
    const commandType = frame.type as RemoteLifecycleCommandTypeV1;
    this.sendEvent("command.accepted", {
      commandId: frame.payload.commandId,
      commandType,
      acceptedAt: this.now(),
    }, this.controlStream, frame.messageId);
    try {
      this.assertCapability(frame.type);
      await this.executeCommand(frame as Exclude<RemoteClientFrameV1, { readonly type: "stream.ack" }>);
    } catch (error) {
      const remoteError = toRemoteError(error);
      this.sendCommandFailed(commandType, frame.payload.commandId, remoteError, frame.messageId);
    }
  }

  private async executeCommand(frame: Exclude<RemoteClientFrameV1, { readonly type: "stream.ack" }>): Promise<void> {
    const payload = frame.payload;
    switch (frame.type) {
      case "session.ping":
        this.complete(frame, { kind: "pong", nonce: frame.payload.nonce });
        return;
      case "stream.subscribe": {
        this.assertScope(frame.payload.scope);
        const stream = this.createStream(frame.payload.scope);
        this.complete(frame, { kind: "subscribed", snapshotRequired: true });
        this.sendSnapshot(stream);
        return;
      }
      case "stream.unsubscribe": {
        if (frame.payload.streamId === this.controlStream.id || !this.streams.has(frame.payload.streamId)) {
          throw new RemoteAccessError("resync_required", "The requested stream is not active.", true);
        }
        this.complete(frame, { kind: "unsubscribed" });
        this.streams.delete(frame.payload.streamId);
        return;
      }
      case "snapshot.request": {
        this.assertScope(frame.payload.scope);
        const stream = this.findOrCreateStream(frame.payload.scope);
        this.complete(frame, { kind: "snapshot_requested" });
        this.sendSnapshot(stream);
        return;
      }
      case "conversation.list": {
        const snapshot = this.options.facade.listConversations(frame.payload.workspaceId);
        this.complete(frame, { kind: "conversation_list_requested" });
        this.sendEvent("conversation.list_snapshot", snapshot, this.workspaceStream(), frame.messageId);
        return;
      }
      case "conversation.open": {
        const snapshot = this.options.facade.openConversation(
          frame.payload.workspaceId,
          frame.payload.conversationId,
          frame.payload.olderPageCursor,
        );
        this.complete(frame, { kind: "conversation_opened", conversationId: frame.payload.conversationId });
        this.sendEvent("conversation.snapshot", snapshot, this.conversationStream(frame.payload.workspaceId, frame.payload.conversationId), frame.messageId);
        return;
      }
      case "conversation.send_text": {
        const bodyHash = encodeBase64Url(sha256(commandHashBytes(commandHashInput(
          this.options.gatewayId,
          this.options.authenticated.device.deviceEpoch,
          frame.payload,
          this.options.policy.policyVersion,
        ))));
        const result = this.options.facade.sendText(frame.payload, { deviceId: this.deviceId, bodyHash });
        this.complete(frame, result);
        this.options.onMutation?.();
        return;
      }
      case "conversation.mark_read": {
        const result = this.options.facade.markRead(frame.payload);
        this.complete(frame, result);
        this.options.onMutation?.();
        return;
      }
      case "profile.read": {
        const profile = this.options.facade.readProfile(frame.payload.workspaceId);
        this.complete(frame, { kind: "profile_read_requested" });
        this.sendEvent("profile.snapshot", profile, this.workspaceStream(), frame.messageId);
        return;
      }
      case "profile.update": {
        const profile = this.options.facade.updateProfile(frame.payload);
        this.complete(frame, { kind: "profile_updated", revision: profile.revision });
        this.sendEvent("profile.snapshot", profile, this.workspaceStream(), frame.messageId);
        this.options.onMutation?.();
        return;
      }
      case "security.unpair":
        this.complete(frame, { kind: "device_unpaired" });
        this.options.onSelfUnpair?.();
        return;
      default:
        throw new RemoteAccessError("protocol_incompatible", `Unsupported command: ${(payload as { commandId: string }).commandId}`);
    }
  }

  private complete(
    frame: Exclude<RemoteClientFrameV1, { readonly type: "stream.ack" }>,
    result: RemoteCommandResultMapV1[RemoteLifecycleCommandTypeV1],
  ): void {
    const completed: RemoteCommandCompletedV1 = {
      commandId: frame.payload.commandId,
      commandType: frame.type,
      result,
      completedAt: this.now(),
    } as RemoteCommandCompletedV1;
    this.sendEvent("command.completed", completed, this.controlStream, frame.messageId);
  }

  private sendCommandFailed(
    commandType: RemoteLifecycleCommandTypeV1,
    commandId: string,
    error: { readonly code: RemoteCommandFailedV1["error"]["code"]; readonly message: string; readonly retryable: boolean },
    requestId: string,
  ): void {
    const failed = {
      commandId,
      commandType,
      error,
      failedAt: this.now(),
    } as RemoteCommandFailedV1;
    this.sendEvent("command.failed", failed, this.controlStream, requestId);
  }

  private sendSnapshot(stream: RemoteStreamState): void {
    stream.snapshotId = `snapshot_${randomUUID()}`;
    if (stream.scope.kind === "workspace") {
      this.sendEvent("workspace.summary", this.options.facade.workspaceSummary(), stream);
      this.sendEvent("conversation.list_snapshot", this.options.facade.listConversations(stream.scope.workspaceId), stream);
      this.sendEvent("profile.snapshot", this.options.facade.readProfile(stream.scope.workspaceId), stream);
    } else {
      this.sendEvent("conversation.snapshot", this.options.facade.openConversation(
        stream.scope.workspaceId,
        stream.scope.conversationId,
      ), stream);
    }
  }

  private assertCapability(commandType: RemoteLifecycleCommandTypeV1): void {
    const required = commandCapability(commandType);
    if (required && !this.options.policy.capabilities.includes(required)) {
      throw new RemoteAccessError("capability_not_allowed", `Remote capability is not allowed: ${required}`);
    }
  }

  private sendEvent<TType extends RemoteServerEventTypeV1>(
    type: TType,
    payload: RemoteServerEventPayloadMapV1[TType],
    stream: RemoteStreamState,
    requestId?: string,
  ): void {
    if (this.closed || this.options.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.options.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(1013, "Remote client is too slow; resync required.");
      return;
    }
    const occurredAt = this.now();
    stream.serverSeq += 1;
    const frame: RemoteServerFrameV1 = {
      version: REMOTE_PROTOCOL_VERSION,
      type,
      messageId: `server_message_${randomUUID()}`,
      gatewayId: this.options.gatewayId,
      sessionId: this.sessionId,
      sentAt: occurredAt,
      ...(requestId ? { requestId } : {}),
      payload,
      streamId: stream.id,
      eventId: `event_${randomUUID()}`,
      serverSeq: stream.serverSeq,
      occurredAt,
    } as RemoteServerFrameV1;
    this.options.socket.send(JSON.stringify(frame));
  }

  private handleAck(streamId: string, ackServerSeq: number): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      this.closePolicyViolation("Acknowledged stream is not active.");
      return;
    }
    const decision = evaluateCumulativeAckV1(stream.ackServerSeq, stream.serverSeq, ackServerSeq);
    if (decision.kind === "advance") {
      stream.ackServerSeq = decision.next;
      return;
    }
    if (decision.kind !== "duplicate") {
      this.closePolicyViolation("Stream acknowledgement is invalid.");
    }
  }

  private assertScope(scope: RemoteStreamScopeV1): void {
    if (scope.kind === "workspace") {
      this.options.facade.listConversations(scope.workspaceId);
    } else {
      this.options.facade.openConversation(scope.workspaceId, scope.conversationId);
    }
  }

  private createStream(scope: RemoteStreamScopeV1): RemoteStreamState {
    const existing = this.findStream(scope);
    if (existing) {
      return existing;
    }
    const stream: RemoteStreamState = {
      id: `stream_${randomUUID()}`,
      scope,
      snapshotId: `snapshot_${randomUUID()}`,
      serverSeq: 0,
      ackServerSeq: 0,
    };
    this.streams.set(stream.id, stream);
    return stream;
  }

  private findOrCreateStream(scope: RemoteStreamScopeV1): RemoteStreamState {
    return this.findStream(scope) ?? this.createStream(scope);
  }

  private findStream(scope: RemoteStreamScopeV1): RemoteStreamState | undefined {
    return [...this.streams.values()].find((stream) => sameScope(stream.scope, scope));
  }

  private workspaceStream(): RemoteStreamState {
    return [...this.streams.values()].find((stream) => stream !== this.controlStream && stream.scope.kind === "workspace")
      ?? this.controlStream;
  }

  private conversationStream(workspaceId: string, conversationId: string): RemoteStreamState {
    return this.findOrCreateStream({ kind: "conversation", workspaceId, conversationId });
  }

  private consumeRateLimit(): void {
    const nowMs = Date.parse(this.now());
    if (nowMs - this.commandWindowStartedAt >= 60_000) {
      this.commandWindowStartedAt = nowMs;
      this.commandCount = 0;
    }
    this.commandCount += 1;
    if (this.commandCount > MAX_COMMANDS_PER_MINUTE) {
      throw new RemoteAccessError("rate_limited", "Remote command rate exceeded.", true);
    }
  }

  private closePolicyViolation(reason: string): void {
    this.close(1008, reason.slice(0, 120));
  }

  private close(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.options.socket.close(code, reason.slice(0, 120));
    this.options.onClosed?.(this);
  }
}

function commandCapability(
  commandType: RemoteLifecycleCommandTypeV1,
): RemoteAccessPolicySummaryV1["capabilities"][number] | undefined {
  if (commandType === "conversation.list" || commandType === "conversation.open" || commandType === "snapshot.request" || commandType === "stream.subscribe") {
    return "conversation.read";
  }
  if (commandType === "conversation.send_text") {
    return "conversation.send_text";
  }
  if (commandType === "conversation.mark_read") {
    return "conversation.mark_read";
  }
  if (commandType === "profile.read") {
    return "profile.read";
  }
  if (commandType === "profile.update") {
    return "profile.update";
  }
  if (commandType === "security.unpair") {
    return "security.unpair";
  }
  return undefined;
}

function sameScope(left: RemoteStreamScopeV1, right: RemoteStreamScopeV1): boolean {
  return left.kind === right.kind
    && left.workspaceId === right.workspaceId
    && (left.kind === "workspace" || (right.kind === "conversation" && left.conversationId === right.conversationId));
}

function deltaConversationId(delta: RemoteConversationDeltaV1): string {
  if (delta.operation === "conversation_upsert") {
    return delta.conversation.conversationId;
  }
  if (delta.operation === "read_state") {
    return delta.readState.conversationId;
  }
  return delta.conversationId;
}

function toRemoteError(error: unknown): RemoteCommandFailedV1["error"] {
  if (error instanceof RemoteAccessError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "pc_unavailable", message: error instanceof Error ? error.message : String(error), retryable: false };
}
