import { closeSync, fstatSync, writeSync } from "node:fs";
import type { Readable } from "node:stream";

/** Separate from the ordinary 20s service-readiness budget; never extended by activity. */
export const DAEMON_RESOURCE_BOOTSTRAP_TIMEOUT_MS = 60_000;

export class DaemonResourceBootstrapError extends Error {
  constructor(readonly code: string) { super(code); this.name = "DaemonResourceBootstrapError"; }
}

/** Called only after all packaged resources have been authenticated and retained. */
export function writeDaemonResourceBootstrap(input: { readonly fd: number }): void {
  if (input.fd !== 4) throw new DaemonResourceBootstrapError("daemon_resource_bootstrap_invalid");
  try {
    const info = fstatSync(input.fd);
    if (!info.isFIFO() && !info.isSocket()) throw new DaemonResourceBootstrapError("daemon_resource_bootstrap_insecure");
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, phase: "resources_ready", pid: process.pid }));
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(input.fd, bytes, offset, bytes.length - offset);
      if (!written) throw new DaemonResourceBootstrapError("daemon_resource_bootstrap_unavailable");
      offset += written;
    }
  } finally { closeSync(input.fd); }
}

/** Only the retained child's inherited FD4; stdout, files and HTTP cannot supply this receipt. */
export function readDaemonResourceBootstrap(input: {
  readonly channel: Readable;
  readonly pid: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (code?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", unavailable);
      input.channel.off("data", data).off("end", end).off("error", unavailable).off("close", unavailable);
      // destroy(ioError) may have queued its error before an abort wins this
      // promise. Keep an error drain until close so it cannot crash the Host.
      const drainError = (): void => undefined;
      const removeDrain = (): void => {
        input.channel.off("error", drainError).off("close", removeDrain);
      };
      input.channel.on("error", drainError).once("close", removeDrain);
      // Node marks closed before its queued error/close events are emitted.
      // If close already ran, dispose on the next loop, after those events.
      if (input.channel.closed) setImmediate(removeDrain);
      input.channel.destroy();
      if (code) reject(new DaemonResourceBootstrapError(code));
      else resolve();
    };
    const unavailable = (): void => finish("daemon_resource_bootstrap_unavailable");
    const timer = setTimeout(() => finish("daemon_resource_bootstrap_timeout"), DAEMON_RESOURCE_BOOTSTRAP_TIMEOUT_MS);
    const data = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > 1024) { finish("daemon_resource_bootstrap_invalid"); return; }
      chunks.push(chunk);
    };
    const end = (): void => {
      try {
        const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!record || Object.keys(record).sort().join(",") !== "phase,pid,schemaVersion"
          || record.schemaVersion !== 1 || record.phase !== "resources_ready"
          || !Number.isSafeInteger(input.pid) || input.pid < 1 || record.pid !== input.pid) {
          finish("daemon_resource_bootstrap_invalid");
        } else finish();
      } catch { finish("daemon_resource_bootstrap_invalid"); }
    };
    input.channel.on("data", data).once("end", end).once("error", unavailable).once("close", unavailable);
    input.signal?.addEventListener("abort", unavailable, { once: true });
    if (input.signal?.aborted || input.channel.destroyed || input.channel.readableEnded) unavailable();
  });
}
