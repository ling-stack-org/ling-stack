import type { ServerResponse } from "node:http";
import { encodeSseFrame } from "./response.js";

export const SSE_STREAM_MAX_FRAME_BYTES = 128 * 1024;
export const SSE_STREAM_MAX_BUFFERED_BYTES = 1024 * 1024;
export const SSE_STREAM_MAX_PENDING_FRAMES = 500;
export const SSE_STREAM_BLOCKED_TIMEOUT_MS = 5_000;
export const SSE_STREAM_CLOSE_GRACE_MS = 1_000;

export interface SseStreamWriterOptions {
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxPendingFrames?: number;
  readonly blockedTimeoutMs?: number;
  readonly closeGraceMs?: number;
  readonly retainedUpstream?: () => { readonly bytes: number; readonly count: number };
  readonly onClose?: () => void;
}

interface PendingFrame { readonly text: string; readonly bytes: number; readonly key?: string }

/** A response-local, bounded notification writer. Drain is not a remote ACK. */
export class SseStreamWriter {
  private readonly queue: PendingFrame[] = [];
  private pendingBytes = 0;
  private blocked = false;
  private pumping = false;
  private writing = false;
  private writingBytes = 0;
  private drainedDuringWrite = false;
  private finishing = false;
  private closed = false;
  private deadline?: NodeJS.Timeout;
  private grace?: NodeJS.Timeout;

  constructor(private readonly response: ServerResponse, private readonly options: SseStreamWriterOptions = {}) {
    response.on?.("drain", this.onDrain);
    response.on?.("close", this.onResponseClose);
    response.on?.("error", this.onResponseClose);
    if (response.writableNeedDrain) this.waitForDrain();
  }

  write(event: string, data: unknown, key?: string): boolean {
    if (this.closed || this.finishing) return false;
    try { return this.writeFrame(encodeSseFrame(event, data), key); }
    catch { this.close(); return false; }
  }

  writeComment(comment: string): boolean {
    return this.writeFrame(`: ${comment.replace(/[\r\n]/g, " ")}\n\n`);
  }

  /** Call immediately after changing a retained upstream queue, not only at flush. */
  checkCapacity(extraBytes = 0, extraCount = 0): boolean {
    if (this.closed) return false;
    if (this.response.destroyed || this.response.writableEnded) { this.close(); return false; }
    let upstream: { readonly bytes: number; readonly count: number };
    try { upstream = this.options.retainedUpstream?.() ?? { bytes: 0, count: 0 }; }
    catch { this.close(); return false; }
    const bytes = this.pendingBytes + this.writingBytes + upstream.bytes + Math.max(0, this.response.writableLength || 0) + extraBytes;
    const count = this.queue.length + (this.writing ? 1 : 0) + upstream.count + extraCount;
    if (bytes > (this.options.maxBufferedBytes ?? SSE_STREAM_MAX_BUFFERED_BYTES) ||
      count > (this.options.maxPendingFrames ?? SSE_STREAM_MAX_PENDING_FRAMES)) {
      this.close(); return false;
    }
    return true;
  }

  /** End only after queued complete frames have been accepted, within the same deadline. */
  finish(): void {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    this.pump();
  }

  /** Abort intake synchronously, discard unsent notifications and bound socket shutdown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.pendingBytes = 0;
    this.clearDeadline();
    this.response.off?.("drain", this.onDrain);
    this.response.off?.("close", this.onResponseClose);
    this.response.off?.("error", this.onResponseClose);
    try { this.options.onClose?.(); }
    finally { this.endResponse(); }
  }

  private writeFrame(text: string, key?: string): boolean {
    if (this.closed || this.finishing) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > (this.options.maxFrameBytes ?? SSE_STREAM_MAX_FRAME_BYTES)) { this.close(); return false; }
    const index = key ? this.queue.findIndex(frame => frame.key === key) : -1;
    const previous = index >= 0 ? this.queue[index] : undefined;
    if (!this.checkCapacity(bytes - (previous?.bytes ?? 0), previous ? 0 : 1)) return false;
    const frame = { text, bytes, ...(key ? { key } : {}) };
    if (index >= 0) this.queue[index] = frame;
    else this.queue.push(frame);
    this.pendingBytes += bytes - (previous?.bytes ?? 0);
    this.pump();
    return !this.closed;
  }

  private pump(): void {
    if (this.closed || this.blocked || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && !this.blocked && this.queue.length > 0) {
        if (!this.checkCapacity()) break;
        const frame = this.queue.shift()!;
        this.pendingBytes -= frame.bytes;
        this.drainedDuringWrite = false;
        this.writing = true;
        this.writingBytes = frame.bytes;
        let accepted: boolean;
        try { accepted = this.response.write(frame.text); }
        catch { this.close(); break; }
        finally { this.writing = false; this.writingBytes = 0; }
        // false means this exact frame was accepted; it is never queued again.
        if (!accepted && !this.drainedDuringWrite) this.waitForDrain();
        if (!this.checkCapacity()) break;
      }
    } finally { this.pumping = false; }
    if (this.finishing && !this.closed && !this.blocked && this.queue.length === 0) this.close();
  }

  private readonly onDrain = (): void => {
    if (this.closed) return;
    if (this.writing) { this.drainedDuringWrite = true; return; }
    if (!this.blocked) return;
    this.blocked = false;
    this.clearDeadline();
    this.pump();
  };

  private readonly onResponseClose = (): void => { this.close(); };

  private waitForDrain(): void {
    if (this.closed || this.blocked) return;
    this.blocked = true;
    this.deadline = setTimeout(() => this.close(), this.options.blockedTimeoutMs ?? SSE_STREAM_BLOCKED_TIMEOUT_MS);
    this.deadline.unref?.();
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  private endResponse(): void {
    const clearGrace = (): void => {
      if (this.grace) clearTimeout(this.grace);
      this.grace = undefined;
      this.response.off?.("finish", clearGrace);
      this.response.off?.("close", clearGrace);
      this.response.off?.("error", clearGrace);
    };
    if (this.response.destroyed || this.response.writableFinished) return;
    this.response.once?.("finish", clearGrace);
    this.response.once?.("close", clearGrace);
    this.response.once?.("error", clearGrace);
    this.grace = setTimeout(() => {
      clearGrace();
      if (!this.response.destroyed && !this.response.writableFinished) this.response.destroy?.();
    }, this.options.closeGraceMs ?? SSE_STREAM_CLOSE_GRACE_MS);
    this.grace.unref?.();
    try { if (!this.response.writableEnded) this.response.end(); }
    catch { clearGrace(); this.response.destroy?.(); }
  }
}
