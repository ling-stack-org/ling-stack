import { closeSync, fstatSync, writeSync } from "node:fs";
import type { Readable } from "node:stream";

export type DaemonShutdownPhase = "draining" | "blocked";
export const DAEMON_SHUTDOWN_OBSERVER_MAX_BYTES = 512;

export class DaemonShutdownObserverError extends Error {
  constructor(readonly code: "daemon_shutdown_observer_invalid" | "daemon_shutdown_observer_unavailable") {
    super(code);
    this.name = "DaemonShutdownObserverError";
  }
}

/** Private FD5 observations are not stopped/effect receipts or replay authority. */
export function createDaemonShutdownReporter(input: { readonly fd: number }): {
  publish(phase: DaemonShutdownPhase): void;
} {
  if (input.fd !== 5) throw new DaemonShutdownObserverError("daemon_shutdown_observer_invalid");
  const info = fstatSync(input.fd);
  if (!info.isFIFO() && !info.isSocket()) throw new DaemonShutdownObserverError("daemon_shutdown_observer_invalid");
  let previous: DaemonShutdownPhase | undefined;
  let unavailable = false;
  const close = (): void => { try { closeSync(input.fd); } catch { /* Already unavailable. */ } };
  return {
    publish(phase) {
      if (unavailable) throw new DaemonShutdownObserverError("daemon_shutdown_observer_unavailable");
      if (!(phase === "draining" && previous === undefined)
        && !(phase === "blocked" && previous === "draining")) {
        throw new DaemonShutdownObserverError("daemon_shutdown_observer_invalid");
      }
      const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, phase, pid: process.pid })}\n`);
      // Advance before I/O: partial delivery must never permit a duplicate frame.
      previous = phase;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(input.fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error("unavailable");
          offset += written;
        }
        if (phase === "blocked") { unavailable = true; close(); }
      } catch {
        unavailable = true;
        close();
        throw new DaemonShutdownObserverError("daemon_shutdown_observer_unavailable");
      }
    },
  };
}

/** Bind only to the retained direct child's inherited pipe, never an HTTP/file payload. */
export function observeDaemonShutdown(input: {
  readonly channel: Readable;
  readonly pid: number;
  readonly onPhase: (phase: DaemonShutdownPhase) => void;
  readonly onUnavailable: (code: DaemonShutdownObserverError["code"]) => void;
}): () => void {
  let previous: DaemonShutdownPhase | undefined;
  let bytes = 0;
  let pending = Buffer.alloc(0);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    input.channel.off("data", data).off("end", end).off("error", unavailable).off("close", unavailable);
    // A queued I/O error can still arrive after cancellation/destroy wins.
    const drainError = (): void => undefined;
    const removeDrain = (): void => { input.channel.off("error", drainError).off("close", removeDrain); };
    input.channel.on("error", drainError).once("close", removeDrain);
    if (input.channel.closed) setImmediate(removeDrain);
    input.channel.destroy();
    pending = Buffer.alloc(0);
  };
  const fail = (code: DaemonShutdownObserverError["code"]): void => {
    if (disposed) return;
    dispose();
    try { input.onUnavailable(code); } catch { /* An observer must not crash its owner. */ }
  };
  const unavailable = (): void => fail("daemon_shutdown_observer_unavailable");
  const invalid = (): void => fail("daemon_shutdown_observer_invalid");
  const data = (chunk: Buffer | string): void => {
    if (disposed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += incoming.length;
    if (bytes > DAEMON_SHUTDOWN_OBSERVER_MAX_BYTES) { invalid(); return; }
    pending = Buffer.concat([pending, incoming]);
    let newline: number;
    while (!disposed && (newline = pending.indexOf(10)) !== -1) {
      const frame = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      let record: unknown;
      try { record = JSON.parse(frame.toString("utf8")); } catch { invalid(); return; }
      if (!record || typeof record !== "object" || Array.isArray(record)
        || Object.keys(record).sort().join(",") !== "phase,pid,schemaVersion") { invalid(); return; }
      const value = record as Record<string, unknown>;
      if (value.schemaVersion !== 1 || value.pid !== input.pid
        || !(value.phase === "draining" && previous === undefined
          || value.phase === "blocked" && previous === "draining")) { invalid(); return; }
      previous = value.phase;
      try { input.onPhase(previous); } catch { unavailable(); return; }
    }
  };
  const end = (): void => {
    if (pending.length) { invalid(); return; }
    // Even clean EOF after draining is not success. The owner must separately
    // await the real child's exit; pipe EOF may precede that exit notification.
    if (previous !== "blocked") { unavailable(); return; }
    dispose();
  };
  input.channel.on("data", data).once("end", end).once("error", unavailable).once("close", unavailable);
  if (!Number.isSafeInteger(input.pid) || input.pid < 1) invalid();
  else if (input.channel.destroyed || input.channel.readableEnded) unavailable();
  return dispose;
}
