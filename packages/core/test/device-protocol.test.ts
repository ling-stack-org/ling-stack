import assert from "node:assert/strict";
import test from "node:test";

import { HardwareProtocolProfileRegistry, HardwareProtocolWorkbench } from "../dist/device-protocol.js";
import { HardwareProtocolTransportRegistry } from "../dist/device-protocol-transport.js";
import { modbusRtuRegisterCodec } from "../dist/modbus-rtu.js";
import { DeviceFabricError } from "../dist/device-fabric.js";

test("protocol profiles bind a verified codec to target facts and reusable capabilities", () => {
  const workbench = new HardwareProtocolWorkbench();
  workbench.registerCodec(modbusRtuRegisterCodec);
  const registry = new HardwareProtocolProfileRegistry(workbench);
  const profile = registry.register({
    profileId: "vehicle-modbus-temperature",
    version: "1.0.0",
    codecId: modbusRtuRegisterCodec.manifest.codecId,
    transport: "rs485",
    supportedDeviceKinds: ["vehicle", "hardware"],
    supportedModels: ["fixture-controller"],
    supportedFirmwareRanges: ["1.2.0"],
    capabilityIds: ["protocol.read_registers"],
    license: "MIT",
  });
  assert.equal(registry.resolve({ deviceKind: "vehicle", model: "fixture-controller", firmwareVersion: "1.2.0" }), profile);
  assert.deepEqual(registry.list().map(item => item.profileId), ["vehicle-modbus-temperature"]);
  assert.throws(() => registry.register({ ...profile, codecId: "missing" }), error => error instanceof DeviceFabricError && error.code === "target_missing");
  assert.throws(() => registry.resolve({ deviceKind: "vehicle", model: "other" }), error => error instanceof DeviceFabricError && error.code === "target_missing");
  assert.throws(() => registry.resolve({ deviceKind: "hardware", model: "fixture-controller" }), /matches the target facts/);
});

test("live hardware transports produce bounded, loss-aware replay captures", async () => {
  const workbench = new HardwareProtocolWorkbench();
  const registry = new HardwareProtocolTransportRegistry(workbench);
  let closed = 0;
  registry.register({
    transportId: "fixture-rs485", targetDeviceId: "hardware-1", connectionRevision: "rs485-r1", transport: "rs485",
    async *capture() {
      yield { direction: "tx", bytes: Uint8Array.from([1, 3, 0, 0]) };
      yield { direction: "rx", bytes: Uint8Array.from([1, 3, 2, 0, 10]) };
    },
    close() { closed += 1; },
  });
  const bounded = await registry.capture({ captureId: "capture-bounded", targetDeviceId: "hardware-1", transportId: "fixture-rs485", maxFrames: 1, durationMs: 1_000 });
  assert.equal(bounded.frames.length, 1);
  assert.deepEqual(bounded.loss, { reason: "capture_limit" });
  assert.equal(bounded.frames[0]?.digest.length, 64);

  registry.register({
    transportId: "fixture-disconnected", targetDeviceId: "hardware-1", connectionRevision: "serial-r1", transport: "serial",
    async *capture() {
      yield { direction: "rx", bytes: Uint8Array.from([0xaa]) };
      throw new Error("bridge disconnected");
    },
  });
  const disconnected = await registry.capture({ captureId: "capture-disconnected", targetDeviceId: "hardware-1", transportId: "fixture-disconnected" });
  assert.deepEqual(disconnected.loss, { reason: "connection_interrupted" });
  await assert.rejects(() => registry.capture({ captureId: "other", targetDeviceId: "hardware-2", transportId: "fixture-rs485" }),
    { code: "target_changed" });
  await registry.close();
  assert.equal(closed, 1);
});

test("an interrupted hardware capture retains its lease until the transport releases", async () => {
  const registry = new HardwareProtocolTransportRegistry(new HardwareProtocolWorkbench());
  const captureInput = { captureId: "stalled-capture", targetDeviceId: "sensor", transportId: "serial-bridge" };
  const controller = new AbortController();
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  registry.register({
    transportId: captureInput.transportId, targetDeviceId: captureInput.targetDeviceId,
    connectionRevision: "serial-r1", transport: "serial",
    async *capture() {
      yield { direction: "rx", bytes: Uint8Array.of(1) };
      markEntered();
      await released;
    },
  });
  const running = registry.capture({ ...captureInput, signal: controller.signal });
  await entered;
  controller.abort();
  const partial = await running;
  assert.equal(partial.frames.length, 1);
  assert.deepEqual(partial.loss, { reason: "connection_interrupted" });
  await assert.rejects(() => registry.capture({ ...captureInput, captureId: "concurrent" }), { code: "lease_busy" });
  release();
  await registry.close();
});
