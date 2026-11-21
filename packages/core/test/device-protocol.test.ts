import assert from "node:assert/strict";
import test from "node:test";

import { HardwareProtocolProfileRegistry, HardwareProtocolWorkbench } from "../dist/device-protocol.js";
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

