import type { HardwareProtocolCaptureV1, HardwareProtocolFrameV1 } from "@ling-stack/contracts";

import { DeviceFabricError } from "./device-fabric.js";
import { HardwareProtocolWorkbench } from "./device-protocol.js";

export interface HardwareProtocolLiveFrame {
  readonly direction: HardwareProtocolFrameV1["direction"];
  readonly bytes: Uint8Array;
  readonly capturedAt?: string;
}

export interface HardwareProtocolLiveTransport {
  readonly transportId: string;
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

  constructor(workbench: HardwareProtocolWorkbench) { this.#workbench = workbench; }

  register(transport: HardwareProtocolLiveTransport): void {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(transport.transportId)) throw new DeviceFabricError("revision_conflict", "hardware transport identity is invalid");
    if (this.#transports.has(transport.transportId)) throw new DeviceFabricError("resource_conflict", "hardware transport is already registered");
    this.#transports.set(transport.transportId, transport);
  }

  get(transportId: string): HardwareProtocolLiveTransport | undefined { return this.#transports.get(transportId); }

  list(): readonly HardwareProtocolLiveTransport[] { return [...this.#transports.values()].sort((left, right) => left.transportId.localeCompare(right.transportId)); }

  async capture(input: HardwareProtocolLiveCaptureOptions): Promise<HardwareProtocolCaptureV1> {
    if (!input.captureId.trim() || !input.targetDeviceId.trim()) throw new DeviceFabricError("revision_conflict", "hardware capture identity is invalid");
    const durationMs = input.durationMs ?? 30_000;
    const maxFrames = input.maxFrames ?? 1_024;
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000 || !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 100_000) {
      throw new DeviceFabricError("revision_conflict", "hardware capture bounds are invalid");
    }
    const transport = this.#transports.get(input.transportId);
    if (!transport) throw new DeviceFabricError("target_missing", "hardware transport is unavailable");
    const createdAt = input.createdAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) throw new DeviceFabricError("revision_conflict", "hardware capture timestamp is invalid");
    const deadline = AbortSignal.timeout(durationMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const frames: { readonly direction: HardwareProtocolFrameV1["direction"]; readonly bytes: Uint8Array; readonly capturedAt: string }[] = [];
    let loss: HardwareProtocolCaptureV1["loss"];
    try {
      for await (const frame of transport.capture({ targetDeviceId: input.targetDeviceId, signal })) {
        if (signal.aborted) { loss = { reason: input.signal?.aborted ? "connection_interrupted" : "capture_limit" }; break; }
        if (!frame || !["tx", "rx"].includes(frame.direction) || !(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength === 0 || frame.bytes.byteLength > 64 * 1024) {
          throw new DeviceFabricError("revision_conflict", "hardware transport emitted an invalid frame");
        }
        const capturedAt = frame.capturedAt ?? new Date().toISOString();
        if (!Number.isFinite(Date.parse(capturedAt))) throw new DeviceFabricError("revision_conflict", "hardware frame timestamp is invalid");
        frames.push({ direction: frame.direction, bytes: new Uint8Array(frame.bytes), capturedAt });
        if (frames.length >= maxFrames) { loss = { reason: "capture_limit", droppedFrames: 1 }; break; }
      }
    } catch (error) {
      if (signal.aborted) loss = { reason: input.signal?.aborted ? "connection_interrupted" : "capture_limit" };
      else if (error instanceof DeviceFabricError) throw error;
      else loss = { reason: "connection_interrupted" };
    }
    if (frames.length === 0 && !loss) loss = { reason: "connection_interrupted" };
    return this.#workbench.capture({ captureId: input.captureId, targetDeviceId: input.targetDeviceId, transport: transport.transport, source: "live", frames, ...(loss ? { loss } : {}), createdAt });
  }

  async close(): Promise<void> {
    const closers = this.list().map(transport => transport.close?.());
    await Promise.all(closers.map(async closer => await closer));
    this.#transports.clear();
  }
}
