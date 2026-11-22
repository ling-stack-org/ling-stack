import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HardwareProtocolTransportRegistry, HardwareProtocolWorkbench, modbusRtuRegisterCodec } from "@ling-stack/core";
import { bindModbusSerialTarget, readModbusSerialTargets, type ConfiguredModbusSerialTarget } from "../dist/features/device-support/modbus-serial-targets.js";
import { createDaemonServer } from "../dist/index.js";

const target: ConfiguredModbusSerialTarget = {
  transportId: "bench-sensor", displayName: "Bench sensor", path: "COM12", vendorId: "0403", productId: "6001",
  serialNumber: "bench-fixture", baudRate: 9600, parity: "even", stopBits: 1,
  read: { unitAddress: 1, table: "holding", startAddress: 0, quantity: 1 },
};

test("serial configuration binds a unique, read-only Modbus target", t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-modbus-serial-config-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "modbus.json");
  const write = (targets: readonly unknown[]) => writeFileSync(path, JSON.stringify({ version: 1, targets }));
  write([{ ...target, path: "com12" }]);
  assert.deepEqual(readModbusSerialTargets(path), [target]);
  write([{ ...target, read: { ...target.read, unitAddress: 0 } }]);
  assert.throws(() => readModbusSerialTargets(path), /Invalid Modbus serial target/u);
  write([{ ...target, read: { ...target.read, startAddress: 65_535, quantity: 2 } }]);
  assert.throws(() => readModbusSerialTargets(path), /Invalid Modbus serial target/u);
  write([{ ...target, read: { ...target.read, table: "coil" } }]);
  assert.throws(() => readModbusSerialTargets(path), /Invalid Modbus serial target/u);
  write([{ ...target, path: "../../settings.json" }]);
  assert.throws(() => readModbusSerialTargets(path), /Invalid Modbus serial target/u);
  write([target, { ...target, transportId: "duplicate" }]);
  assert.throws(() => readModbusSerialTargets(path), /must be unique/u);
  const original = bindModbusSerialTarget(target).transport;
  const moved = bindModbusSerialTarget({ ...target, path: "COM13" }).transport;
  assert.equal(moved.targetDeviceId, original.targetDeviceId);
  assert.notEqual(moved.connectionRevision, original.connectionRevision);
  assert.notEqual(bindModbusSerialTarget({ ...target, read: { ...target.read, unitAddress: 2 } }).transport.targetDeviceId, original.targetDeviceId);
});

test("the serial transport captures a request and fragmented register response with exact port settings", async () => {
  const { bound, workbench, registry, events } = serialFixture(["01", "0302", "000a", "38", "43"]);
  try {
    const capture = await registry.capture({ captureId: "bench-capture", targetDeviceId: bound.targetDeviceId, transportId: bound.transportId });
    assert.equal(capture.loss, undefined);
    assert.deepEqual(capture.frames.map(frame => Buffer.from(frame.bytesBase64, "base64").toString("hex")), ["010300000001840a", "010302000a3843"]);
    assert.equal(workbench.decode(capture, modbusRtuRegisterCodec.manifest.codecId)[1]?.fields.register0, 10);
    assert.deepEqual(events, [
      { path: "COM12", baudRate: 9600, parity: "even", stopBits: 1, dataBits: 8, lock: true, hupcl: false },
      "flush", "write:010300000001840a", "drain", "close",
    ]);
  } finally {
    await registry.close();
  }
});

test("serial captures keep partial traffic through a disconnect and never open an unpinned port", async () => {
  const partial = serialFixture(["010302", "00"]);
  const replacement = serialFixture([], "replaced-serial");
  const changedWhileOpening = serialFixture([], target.serialNumber, "replaced-serial");
  try {
    const interrupted = await partial.registry.capture({ captureId: "partial", targetDeviceId: partial.bound.targetDeviceId, transportId: partial.bound.transportId });
    assert.deepEqual(interrupted.loss, { reason: "connection_interrupted" });
    assert.equal(Buffer.from(interrupted.frames[1]!.bytesBase64, "base64").toString("hex"), "01030200");
    assert.equal(partial.events.at(-1), "close");
    const absent = await replacement.registry.capture({ captureId: "replacement", targetDeviceId: replacement.bound.targetDeviceId, transportId: replacement.bound.transportId });
    assert.deepEqual(absent.loss, { reason: "connection_interrupted" });
    assert.deepEqual(absent.frames, []);
    assert.deepEqual(replacement.events, []);
    const rebound = await changedWhileOpening.registry.capture({
      captureId: "rebound", targetDeviceId: changedWhileOpening.bound.targetDeviceId, transportId: changedWhileOpening.bound.transportId,
    });
    assert.deepEqual(rebound.loss, { reason: "connection_interrupted" });
    assert.deepEqual(rebound.frames, []);
    assert.equal(changedWhileOpening.events.length, 2);
    assert.equal(changedWhileOpening.events[1], "close");
  } finally {
    await Promise.all([partial.registry.close(), replacement.registry.close(), changedWhileOpening.registry.close()]);
  }
});

test("the configured Daemon exposes a target without port details and rejects capture after a revision change", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-modbus-serial-route-"));
  const targetsFile = join(cwd, "modbus.json");
  const headers = { Authorization: "Bearer fixture-modbus-service", "Content-Type": "application/json" };
  let daemon: ReturnType<typeof createDaemonServer> | undefined;
  async function stop() {
    await daemon?.stop();
    daemon = undefined;
  }
  t.after(async () => {
    await stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  async function start(targets: readonly ConfiguredModbusSerialTarget[]) {
    writeFileSync(targetsFile, JSON.stringify({ version: 1, targets }));
    daemon = createDaemonServer({
      host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd, authToken: "fixture-modbus-service",
      deviceSupport: { modbusSerialTargetsFile: targetsFile },
    }, { chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}/v1/device-support/protocol`;
  }
  const initial = await start([target]);
  const { targetDeviceId } = bindModbusSerialTarget(target).transport;
  const listed = await fetch(initial + "/transports", { headers });
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { transports: [{ transportId: "bench-sensor", targetDeviceId, transport: "rs485", displayName: "Bench sensor" }] });
  const prepare = await fetch(initial + "/sessions", {
    method: "POST", headers, body: JSON.stringify({ profileId: "modbus-rtu-registers", transportId: "bench-sensor", targetDeviceId }),
  });
  assert.equal(prepare.status, 201);
  const { session } = await prepare.json() as { session: { sessionId: string; authorizationRevision: string } };
  await stop();
  const updated = await start([{ ...target, baudRate: 19_200 }]);
  const capture = await fetch(updated + `/sessions/${session.sessionId}/capture`, {
    method: "POST", headers, body: JSON.stringify({ authorizationRevision: session.authorizationRevision }),
  });
  assert.equal(capture.status, 409);
  assert.deepEqual(await capture.json(), { error: "target_changed" });
  await stop();
  const removed = await start([]);
  assert.deepEqual(await (await fetch(removed + "/transports", { headers })).json(), { transports: [] });
});

function serialFixture(chunks: readonly string[], serialNumber = target.serialNumber, openedSerialNumber = serialNumber) {
  const events: unknown[] = [];
  const pending = chunks.map(chunk => Buffer.from(chunk, "hex"));
  const { transport: bound } = bindModbusSerialTarget(target, async () => ({
    async list() {
      return [{
        path: target.path, vendorId: target.vendorId, productId: target.productId, serialNumber: events.length ? openedSerialNumber : serialNumber,
        manufacturer: undefined, pnpId: undefined, locationId: undefined,
      }];
    },
    async open(options) {
      events.push(options);
      return {
        async flush() { events.push("flush"); },
        async write(buffer) { events.push(`write:${buffer.toString("hex")}`); },
        async drain() { events.push("drain"); },
        async close() { events.push("close"); },
        async read(buffer, offset, length) {
          const chunk = pending.shift();
          if (!chunk) throw new Error("Fixture disconnected");
          assert.ok(chunk.length <= length);
          chunk.copy(buffer, offset);
          return { bytesRead: chunk.length, buffer };
        },
      };
    },
  }));
  const workbench = new HardwareProtocolWorkbench();
  workbench.registerCodec(modbusRtuRegisterCodec);
  const registry = new HardwareProtocolTransportRegistry(workbench);
  registry.register(bound);
  return { bound, workbench, registry, events };
}
