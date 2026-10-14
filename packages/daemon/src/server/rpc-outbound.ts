import { redactSecrets } from "@ling-stack/core";
import { WebSocket } from "ws";

export const RPC_OUTBOUND_MAX_FRAME_BYTES = 128 * 1024;
export const RPC_OUTBOUND_MAX_BUFFERED_BYTES = 1024 * 1024;
export const RPC_OUTBOUND_MAX_PENDING_FRAMES = 500;
export const RPC_OUTBOUND_SEND_TIMEOUT_MS = 5_000;
export const RPC_OUTBOUND_CLOSE_GRACE_MS = 1_000;

export interface RpcOutboundFrame {
  readonly text: string;
  readonly bytes: number;
}

export interface RpcOutboundWriterOptions {
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxPendingFrames?: number;
  readonly sendTimeoutMs?: number;
  readonly closeGraceMs?: number;
  readonly onClose?: () => void;
}

interface PendingFrame {
  readonly frame: RpcOutboundFrame;
  readonly group?: string;
}

/** One connection owns every queued frame, upstream reservation and send callback. */
export class RpcOutboundWriter {
  private readonly pending: PendingFrame[] = [];
  private readonly reservations = new Map<string, { readonly bytes: number; readonly count: number }>();
  private readonly limits: Required<Omit<RpcOutboundWriterOptions, "onClose">>;
  private pendingBytes = 0;
  private upstreamBytes = 0;
  private upstreamCount = 0;
  private inFlight?: PendingFrame;
  private sendTimer?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;
  private pumping = false;
  private closed = false;
  private readonly onSocketClose = (): void => {
    this.close(1000, "transport_closed");
    this.detachSocketListeners();
  };
  private readonly onSocketError = (): void => this.close(1011, "transport_error");

  constructor(private readonly ws: WebSocket, private readonly options: RpcOutboundWriterOptions = {}) {
    this.limits = {
      maxFrameBytes: options.maxFrameBytes ?? RPC_OUTBOUND_MAX_FRAME_BYTES,
      maxBufferedBytes: options.maxBufferedBytes ?? RPC_OUTBOUND_MAX_BUFFERED_BYTES,
      maxPendingFrames: options.maxPendingFrames ?? RPC_OUTBOUND_MAX_PENDING_FRAMES,
      sendTimeoutMs: options.sendTimeoutMs ?? RPC_OUTBOUND_SEND_TIMEOUT_MS,
      closeGraceMs: options.closeGraceMs ?? RPC_OUTBOUND_CLOSE_GRACE_MS,
    };
    for (const limit of Object.values(this.limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Invalid RPC outbound limit");
    }
    ws.on("close", this.onSocketClose);
    ws.on("error", this.onSocketError);
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Encode once before retention; a large fact closes this consumer, never truncates it. */
  prepare(value: unknown): RpcOutboundFrame | undefined {
    if (this.closed) return undefined;
    try {
      const text = JSON.stringify(redactSecrets(value));
      if (typeof text !== "string") throw new Error("RPC frame must be JSON serializable");
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > this.limits.maxFrameBytes) {
        this.close(1013, "outbound_frame_limit");
        return undefined;
      }
      return Object.freeze({ text, bytes });
    } catch {
      this.close(1011, "outbound_encoding_failed");
      return undefined;
    }
  }

  send(value: unknown, group?: string): boolean {
    const frame = this.prepare(value);
    return frame !== undefined && this.enqueue(frame, group);
  }

  /** Transfer an already encoded upstream frame without serializing it again. */
  enqueue(frame: RpcOutboundFrame, group?: string): boolean {
    if (this.closed) return false;
    if (frame.bytes > this.limits.maxFrameBytes) {
      this.close(1013, "outbound_frame_limit");
      return false;
    }
    this.pending.push({ frame, ...(group ? { group } : {}) });
    this.pendingBytes += frame.bytes;
    if (!this.checkCapacity()) return false;
    this.pump();
    return !this.closed;
  }

  /** Replace the complete retained size for one upstream queue, not a per-queue allowance. */
  reserve(key: string, bytes: number, count: number): boolean {
    if (this.closed) return false;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(count) || count < 0) {
      this.close(1011, "invalid_outbound_reservation");
      return false;
    }
    const old = this.reservations.get(key);
    this.upstreamBytes += bytes - (old?.bytes ?? 0);
    this.upstreamCount += count - (old?.count ?? 0);
    if (bytes === 0 && count === 0) this.reservations.delete(key);
    else this.reservations.set(key, { bytes, count });
    return this.checkCapacity();
  }

  /** Unsubscribe removes only frames that have not yet crossed the socket boundary. */
  cancelGroup(group: string): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const pending = this.pending[index]!;
      if (pending.group === group) {
        this.pendingBytes -= pending.frame.bytes;
        this.pending.splice(index, 1);
      }
    }
  }

  /** Stop intake and release application ownership before a bounded close handshake. */
  close(code = 1000, reason = "connection_closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.clearSendTimer();
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.inFlight = undefined;
    this.reservations.clear();
    this.upstreamBytes = 0;
    this.upstreamCount = 0;
    try {
      this.options.onClose?.();
    } finally {
      if (this.ws.readyState === WebSocket.CLOSED) {
        this.detachSocketListeners();
      } else {
        this.closeTimer = setTimeout(() => {
          this.closeTimer = undefined;
          try { this.ws.terminate(); }
          finally { this.detachSocketListeners(); }
        }, this.limits.closeGraceMs);
        this.closeTimer.unref?.();
        try { this.ws.close(code, reason); }
        catch {
          try { this.ws.terminate(); }
          finally { this.detachSocketListeners(); }
        }
      }
    }
  }

  private checkCapacity(): boolean {
    if (this.closed) return false;
    const buffered = this.ws.bufferedAmount;
    const bytes = this.pendingBytes + (this.inFlight?.frame.bytes ?? 0) + this.upstreamBytes + buffered;
    const count = this.pending.length + (this.inFlight ? 1 : 0) + this.upstreamCount;
    if (!Number.isFinite(buffered) || buffered < 0 || bytes > this.limits.maxBufferedBytes || count > this.limits.maxPendingFrames) {
      this.close(1013, "slow_client_disconnect");
      return false;
    }
    return true;
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && !this.inFlight && this.pending.length > 0) {
        if (this.ws.readyState !== WebSocket.OPEN) {
          this.close(1000, "transport_not_open");
          return;
        }
        if (!this.checkCapacity()) return;
        const pending = this.pending.shift()!;
        this.pendingBytes -= pending.frame.bytes;
        this.inFlight = pending;
        this.sendTimer = setTimeout(() => this.close(1013, "outbound_send_timeout"), this.limits.sendTimeoutMs);
        this.sendTimer.unref?.();
        let settled = false;
        try {
          this.ws.send(pending.frame.text, (error?: Error) => {
            if (settled) return;
            settled = true;
            if (this.closed || this.inFlight !== pending) return;
            this.clearSendTimer();
            this.inFlight = undefined;
            if (error) {
              this.close(1011, "outbound_send_failed");
              return;
            }
            if (this.checkCapacity()) this.pump();
          });
        } catch {
          this.close(1011, "outbound_send_failed");
        }
        if (!this.closed) this.checkCapacity();
      }
    } finally {
      this.pumping = false;
    }
  }

  private clearSendTimer(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
  }

  private detachSocketListeners(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.ws.off("close", this.onSocketClose);
    this.ws.off("error", this.onSocketError);
  }
}
