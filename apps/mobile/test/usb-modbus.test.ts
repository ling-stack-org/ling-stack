import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { DeviceObservationV1 } from "@ling-stack/contracts";
import { createAsyncStorageMobileDeviceJournal } from "../src/device/journal.ts";
import { createStandaloneDeviceRuntime } from "../src/device/standalone-runtime.ts";
import { replayUsbModbusObservation, UsbModbusInputError, type UsbModbusBridge, type UsbModbusSettings } from "../src/device/usb-modbus.ts";

const time = "2026-11-23T10:00:00.000Z";
const port = { portId: "/dev/bus/usb/001/011:0", portNumber: 0, vendorId: 0x0403, productId: 0x6001,
  label: "RS-485 adapter", permissionGranted: true } as const;
const settings = { baudRate: 9600, parity: "none", stopBits: 1, unitAddress: 1, table: "holding", startAddress: 0,
  quantity: 1 } as const satisfies UsbModbusSettings;

function fixture(usbModbus?: UsbModbusBridge) {
  const data = new Map<string, string>();
  const ownerId = "phone_owner_" + randomUUID();
  return {
    ownerId, usbModbus, randomId: (prefix: string) => prefix === "phone_owner" ? ownerId : prefix + "_" + randomUUID(), now: () => time,
    storage: {
      getItem: async (key: string) => data.get(key) ?? null,
      setItem: async (key: string, value: string) => { data.set(key, value); },
    },
    fetch: async () => { throw new Error("Standalone USB must not contact the network"); },
  };
}

function transfer(replyHex: string, complete = true) {
  return { replyHex, complete, sentAtMs: Date.parse(time), receivedAtMs: Date.parse(time) + 5 };
}

test("standalone USB Modbus reads a selected port and replays a retained capture after reopen", async () => {
  let authorized = false;
  let requests = 0;
  let closes = 0;
  const attached = { ...port, permissionGranted: false };
  const opts = fixture({
    list: async () => [authorized ? port : attached],
    authorize: async selected => { assert.deepEqual(selected, attached); authorized = true; },
    reserve: async selected => {
      assert(authorized);
      assert.deepEqual(selected, port);
      return {
        identity: "fixture-port-digest", stableIdentity: true,
        read: async (configured, hex) => {
          assert.deepEqual(configured, settings);
          assert.equal(hex, "010300000001840a");
          requests += 1;
          return transfer("010302000a3843");
        },
        close: () => { closes += 1; },
      };
    },
  });
  const runtime = await createStandaloneDeviceRuntime(opts);
  await assert.rejects(() => runtime.authorizeUsbModbusPort(attached), /usb_target_missing/u);
  await runtime.setForeground(true);
  assert.deepEqual(await runtime.listUsbModbusPorts(), [attached]);
  await runtime.authorizeUsbModbusPort(attached);
  assert.deepEqual(await runtime.listUsbModbusPorts(), [port]);
  await assert.rejects(() => runtime.diagnoseUsbModbus({ port, settings: { ...settings, quantity: 126 } }), UsbModbusInputError);
  const run = await runtime.diagnoseUsbModbus({ port, settings });
  assert.equal(run.taskStatus, "succeeded");
  assert.deepEqual(run.outcome, { status: "read", unitAddress: 1, table: "holding", startAddress: 0, registers: [10] });
  const reopened = await createStandaloneDeviceRuntime({ ...opts, usbModbus: undefined });
  assert.deepEqual(await reopened.listUsbModbusRuns(), [run]);
  const replay = await reopened.replayUsbModbusCapture(run.taskId);
  assert.equal(replay?.capture.transport, "rs485");
  assert.equal(replay?.capture.frames[1]?.bytesBase64, "AQMCAAo4Qw==");
  assert.deepEqual(replay?.frames.map(frame => [frame.direction, frame.checksumValid, frame.hex]), [
    ["tx", true, "010300000001840a"], ["rx", true, "010302000a3843"],
  ]);
  const evidence = await reopened.readTaskEvidenceExport(run.taskId);
  assert(evidence?.conformanceReports.some(report => report.source?.connectionRevision?.startsWith("usb_connection_")
    && report.transport === "rs485" && report.source.ownerKind === "mobile"));
  assert.doesNotMatch(JSON.stringify(evidence), /010302000a3843|AQMCAAo4Qw==|fixture-port-digest/u);
  assert.equal(requests, 1);
  assert.equal(closes, 1);
});

test("USB Modbus retains failed captures and distinguishes corrupt journal data from a bad wire CRC", async t => {
  for (const scenario of [
    { label: "CRC", reply: transfer("010302000a3842"), expected: "invalid_checksum" },
    { label: "partial reply", reply: transfer("010302", false), expected: "incomplete_capture" },
    { label: "device exception", reply: transfer("018302c0f1"), expected: "device_exception" },
    { label: "different station", reply: transfer("020302000a7c43"), expected: "mismatched_response" },
  ]) {
    await t.test(scenario.label, async () => {
      const opts = fixture({
        list: async () => [port], authorize: async () => {},
        reserve: async () => ({ identity: "ephemeral-attachment", stableIdentity: false,
          read: async () => scenario.reply, close() {} }),
      });
      const runtime = await createStandaloneDeviceRuntime(opts);
      await runtime.setForeground(true);
      const run = await runtime.diagnoseUsbModbus({ port, settings });
      assert.equal(run.taskStatus, "failed");
      assert.equal(run.outcome?.status, scenario.expected);
      const journal = createAsyncStorageMobileDeviceJournal(opts.storage, opts.ownerId);
      const observation = (await journal.listObservations(run.taskId)).find(value => value.source === "modbus.rtu.usb_capture");
      assert(observation);
      const capture = observation.value as Record<string, unknown>;
      assert.equal(capture.identityScope, "attachment");
      const frames = capture.frames as readonly Record<string, unknown>[];
      assert.equal(replayUsbModbusObservation({
        ...observation, value: { ...capture, frames: [frames[0], { ...frames[1], digest: "changed" }] },
      } as DeviceObservationV1, observation.subjectId), undefined);
      assert.equal(replayUsbModbusObservation({
        ...observation, value: { ...capture, frames: [frames[0], { ...frames[1], bytesBase64: "Zh==" }] },
      } as DeviceObservationV1, observation.subjectId), undefined);
    });
  }
});

test("backgrounding the phone releases an in-progress USB reservation and keeps the attempt unresolved", async () => {
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  let rejectRead!: (error: Error) => void;
  const reading = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  let closes = 0;
  const opts = fixture({
    list: async () => [port], authorize: async () => {},
    reserve: async () => ({
      identity: "attachment", stableIdentity: false,
      read() { start(); return reading; },
      close() { closes += 1; rejectRead(new Error("usb_operation_cancelled")); },
    }),
  });
  const runtime = await createStandaloneDeviceRuntime(opts);
  await runtime.setForeground(true);
  const pending = runtime.diagnoseUsbModbus({ port, settings });
  await started;
  await runtime.setForeground(false);
  const run = await pending;
  assert.equal(run.taskStatus, "unknown");
  assert.equal(closes, 1);
  const reopened = await createStandaloneDeviceRuntime({ ...opts, usbModbus: undefined });
  assert.deepEqual(await reopened.listUsbModbusRuns(), [run]);
  assert.equal(await reopened.replayUsbModbusCapture(run.taskId), undefined);
});
