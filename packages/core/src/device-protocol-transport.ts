import type { HardwareProtocolCaptureV1, HardwareProtocolFrameV1 } from "@ling-stack/contracts";

import { DeviceFabricError } from "./device-fabric.js";
import type { HardwareProtocolWorkbench } from "./device-protocol.js";

const maxCaptureBytes = 1024 * 1024;
const maxFrameBytes = 64 * 1024;

export interface HardwareProtocolLiveFrame {
  readonly direction: HardwareProtocolFrameV1["direction"];
  readonly bytes: Uint8Array;
  readonly capturedAt?: string;
}

export interface HardwareProtocolLiveTransport {
  readonly transportId: string;
  readonly targetDeviceId: string;
  readonly connectionRevision: string;
  readonly transport: HardwareProtocolCaptureV1["transport"];
  capture(input: { readonly targetDeviceId: string; readonly signal: AbortSignal }): AsyncIterable<HardwareProtocolLiveFrame>;
  close?(): Promise<void> | void;
}

export interface HardwareProtocolLiveCaptureOptions {
  readonly captureId: string;
  readonly targetDeviceId: string;
  readonly transportId: string;
  readonly createdAt?: string;
  readonly durationMs?: number;
  readonly maxFrames?: number;
  readonly signal?: AbortSignal;
}

/** Runs platform-owned USB/BLE/serial/CAN bridges without putting their APIs in Core. */
export class HardwareProtocolTransportRegistry {
  readonly #workbench: HardwareProtocolWorkbench;
  readonly #transports = new Map<string, HardwareProtocolLiveTransport>();
  readonly #active = new Map<string, AbortController>();

  constructor(workbench: HardwareProtocolWorkbench) { this.#workbench = workbench; }

  register(transport: HardwareProtocolLiveTransport): void {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(transport.transportId) || !transport.targetDeviceId.trim()
      || !transport.connectionRevision.trim()) {
      throw new DeviceFabricError("revision_conflict", "hardware transport identity is invalid");
    }
    if (this.#transports.has(transport.transportId)) throw new DeviceFabricError("resource_conflict", "hardware transport is already registered");
    this.#transports.set(transport.transportId, transport);
  }

  get(transportId: string): HardwareProtocolLiveTransport | undefined { return this.#transports.get(transportId); }

  list(): readonly HardwareProtocolLiveTransport[] { return [...this.#transports.values()].sort((left, right) => left.transportId.localeCompare(right.transportId)); }

  async capture(input: HardwareProtocolLiveCaptureOptions): Promise<HardwareProtocolCaptureV1> {
    if (!input.captureId.trim() || !input.targetDeviceId.trim()) throw new DeviceFabricError("revision_conflict", "hardware capture identity is invalid");
    const durationMs = input.durationMs ?? 30_000;
    const maxFrames = input.maxFrames ?? 1_024;
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000
      || !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 4096) {
      throw new DeviceFabricError("revision_conflict", "hardware capture bounds are invalid");
    }
    const transport = this.#transports.get(input.transportId);
    if (!transport) throw new DeviceFabricError("target_missing", "hardware transport is unavailable");
    if (transport.targetDeviceId !== input.targetDeviceId) throw new DeviceFabricError("target_changed", "hardware transport uses another target");
    if (this.#active.has(input.transportId)) throw new DeviceFabricError("lease_busy", "hardware transport already has an active capture");
    const createdAt = input.createdAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) throw new DeviceFabricError("revision_conflict", "hardware capture timestamp is invalid");
    const deadline = AbortSignal.timeout(durationMs);
    const controller = new AbortController();
    const signal = AbortSignal.any(input.signal ? [controller.signal, input.signal, deadline] : [controller.signal, deadline]);
    signal.throwIfAborted();
    const iterator = transport.capture({ targetDeviceId: input.targetDeviceId, signal })[Symbol.asyncIterator]();
    this.#active.set(input.transportId, controller);
    const frames: { readonly direction: HardwareProtocolFrameV1["direction"]; readonly bytes: Uint8Array; readonly capturedAt: string }[] = [];
    let bytes = 0;
    let finished = false;
    let loss: HardwareProtocolCaptureV1["loss"];
    try {
      while (!signal.aborted) {
        const next = await readFrame(iterator, signal);
        if (!next || signal.aborted) break;
        if (next.done) {
          finished = true;
          break;
        }
        const frame = next.value;
        if (!frame || !["tx", "rx"].includes(frame.direction) || !(frame.bytes instanceof Uint8Array)
          || frame.bytes.byteLength === 0 || frame.bytes.byteLength > maxFrameBytes) {
          throw new DeviceFabricError("revision_conflict", "hardware transport emitted an invalid frame");
        }
        if (frames.length === maxFrames || bytes + frame.bytes.byteLength > maxCaptureBytes) {
          loss = { reason: "capture_limit" };
          break;
        }
        const capturedAt = frame.capturedAt ?? new Date().toISOString();
        if (!Number.isFinite(Date.parse(capturedAt))) throw new DeviceFabricError("revision_conflict", "hardware frame timestamp is invalid");
        frames.push({ direction: frame.direction, bytes: new Uint8Array(frame.bytes), capturedAt });
        bytes += frame.bytes.byteLength;
      }
    } catch (error) {
      if (!signal.aborted && error instanceof DeviceFabricError) throw error;
      loss = { reason: "connection_interrupted" };
    } finally {
      if (finished) this.#active.delete(input.transportId);
      else {
        controller.abort();
        // Keep the lease until the driver releases the active capture.
        void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined)
          .finally(() => { this.#active.delete(input.transportId); });
      }
    }
    if (!finished && !loss) loss = { reason: deadline.aborted ? "capture_limit" : "connection_interrupted" };
    if (frames.length === 0 && !loss) loss = { reason: "connection_interrupted" };
    return this.#workbench.capture({ captureId: input.captureId, targetDeviceId: input.targetDeviceId, transport: transport.transport, source: "live", frames, ...(loss ? { loss } : {}), createdAt });
  }

  async close(): Promise<void> {
    const transports = this.list();
    this.#transports.clear();
    for (const controller of this.#active.values()) controller.abort();
    await Promise.all(transports.map(async transport => await transport.close?.()));
  }
}

async function readFrame(
  iterator: AsyncIterator<HardwareProtocolLiveFrame>, signal: AbortSignal,
): Promise<IteratorResult<HardwareProtocolLiveFrame> | undefined> {
  let cancel: (() => void) | undefined;
  const stopped = new Promise<undefined>(resolve => {
    cancel = () => resolve(undefined);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), stopped]);
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}
