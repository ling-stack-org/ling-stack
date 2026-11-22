import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { DeviceProfileV1 } from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, encodeModbusRtuRegisterRead, type HardwareProtocolLiveTransport } from "@ling-stack/core";
import type { BindingInterface, BindingPortInterface, PortInfo } from "@serialport/bindings-cpp";

export interface ConfiguredModbusSerialTarget {
  readonly transportId: string;
  readonly displayName: string;
  readonly path: string;
  readonly vendorId: string;
  readonly productId: string;
  readonly serialNumber: string;
  readonly baudRate: number;
  readonly parity: "none" | "even" | "odd";
  readonly stopBits: 1 | 2;
  readonly read: Parameters<typeof encodeModbusRtuRegisterRead>[0];
}

export const modbusSerialAdapterId = "modbus-rtu-serial";
const responseTimeoutMs = 2_000;
type SerialConnection = Pick<BindingPortInterface, "read" | "write" | "drain" | "flush" | "close">;
type SerialDriver = Pick<BindingInterface, "list"> & {
  open(options: Parameters<BindingInterface["open"]>[0]): Promise<SerialConnection>;
};

export function readModbusSerialTargets(path: string | undefined): readonly ConfiguredModbusSerialTarget[] {
  if (path === undefined) return [];
  let document: unknown;
  try {
    if (!isAbsolute(path)) throw new Error();
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error();
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Modbus serial configuration must be an absolute path to a readable JSON file");
  }
  if (!hasKeys(document, ["version", "targets"]) || document.version !== 1
    || !Array.isArray(document.targets) || document.targets.length > 32) {
    throw new Error("Modbus serial configuration requires version 1 and at most 32 targets");
  }
  const targets = document.targets.map(parseTarget);
  if (new Set(targets.map(target => target.transportId)).size !== targets.length
    || new Set(targets.map(targetIdentity)).size !== targets.length) {
    throw new Error("Modbus serial transport IDs and USB unit bindings must be unique");
  }
  return targets;
}

function parseTarget(value: unknown, index: number): ConfiguredModbusSerialTarget {
  const fail = (): never => { throw new Error(`Invalid Modbus serial target at index ${index}`); };
  if (!hasKeys(value, ["transportId", "displayName", "path", "vendorId", "productId", "serialNumber", "baudRate", "parity", "stopBits", "read"])) return fail();
  const { transportId, displayName, path, vendorId, productId, serialNumber, baudRate, parity, stopBits, read } = value;
  if (typeof transportId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(transportId)
    || typeof displayName !== "string" || !displayName.trim() || displayName.length > 128 || /[\u0000-\u001f\u007f]/u.test(displayName)
    || !isSerialPath(path)
    || !isUsbId(vendorId) || !isUsbId(productId)
    || typeof serialNumber !== "string" || !/^[ -~]{1,128}$/u.test(serialNumber) || !serialNumber.trim()
    || typeof baudRate !== "number" || ![1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(baudRate)
    || (parity !== "none" && parity !== "even" && parity !== "odd") || (stopBits !== 1 && stopBits !== 2)
    || !hasKeys(read, ["unitAddress", "table", "startAddress", "quantity"])) return fail();
  const { unitAddress, table, startAddress, quantity } = read;
  if (typeof unitAddress !== "number" || (table !== "holding" && table !== "input")
    || typeof startAddress !== "number" || typeof quantity !== "number") return fail();
  const registers = { unitAddress, table, startAddress, quantity } as const;
  try { encodeModbusRtuRegisterRead(registers); } catch { return fail(); }
  return {
    transportId, displayName: displayName.trim(), path: path.startsWith("/") ? path : path.toUpperCase(),
    vendorId: vendorId.toLowerCase(), productId: productId.toLowerCase(),
    serialNumber, baudRate, parity, stopBits, read: registers,
  };
}

export function bindModbusSerialTarget(
  target: ConfiguredModbusSerialTarget,
  loadDriver: () => Promise<SerialDriver> = async () => (await import("@serialport/bindings-cpp")).autoDetect(),
): { readonly profile: DeviceProfileV1; readonly transport: HardwareProtocolLiveTransport } {
  const request = Buffer.from(encodeModbusRtuRegisterRead(target.read));
  const targetDeviceId = `modbus-rtu-${sha256(targetIdentity(target)).slice(0, 32)}`;
  const connectionRevision = sha256(JSON.stringify([
    targetDeviceId, target.transportId, target.path, target.baudRate, target.parity, target.stopBits, request.toString("hex"),
  ]));
  const { transportId, path, baudRate, parity, stopBits } = target;
  const profile: DeviceProfileV1 = {
    device: {
      id: targetDeviceId, kind: "hardware", ownerScope: DEFAULT_WORKSPACE_ID, displayName: target.displayName,
      lifecycleStatus: "enrolled", profileRevision: connectionRevision,
    },
    profileRevision: connectionRevision, adapterId: modbusSerialAdapterId, adapterVersion: "1.0.0", source: "operator",
    transports: ["rs485"], connectionRefs: [connectionRevision],
    transportDeployments: [{ transport: "rs485", mode: "hardware_bridge", pairing: "os_permission", removal: "disconnect_only" }],
  };
  return { profile, transport: {
    transportId, targetDeviceId, connectionRevision, transport: "rs485",
    async *capture(input) {
      if (input.targetDeviceId !== targetDeviceId) throw new Error("Modbus serial capture target changed");
      const { signal } = input;
      signal.throwIfAborted();
      const driver = await loadDriver();
      await requirePinnedPort(driver, target);
      signal.throwIfAborted();
      const connection = await driver.open({ path, baudRate, parity, stopBits, dataBits: 8, lock: true, hupcl: false });
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(responseTimeoutMs)]);
      let closed: Promise<void> | undefined;
      const close = () => { closed ??= connection.close(); return closed; };
      const abort = () => { void close().catch(() => undefined); };
      deadline.addEventListener("abort", abort, { once: true });
      try {
        deadline.throwIfAborted();
        await requirePinnedPort(driver, target);
        deadline.throwIfAborted();
        await connection.flush();
        const idleMs = Math.ceil(3.5 * (9 + stopBits + Number(parity !== "none")) * 1000 / baudRate);
        await delay(idleMs, undefined, { signal: deadline });
        await connection.write(request);
        await connection.drain();
        yield { direction: "tx", bytes: request };
        const reply = await readResponse(connection, deadline);
        if (reply.bytes.length > 0) yield { direction: "rx", bytes: reply.bytes };
        if (!reply.complete) throw new Error("Modbus serial response ended before its complete frame arrived");
      } finally {
        deadline.removeEventListener("abort", abort);
        await close();
      }
    },
  } };
}

async function readResponse(connection: SerialConnection, signal: AbortSignal) {
  const buffer = Buffer.alloc(256);
  let length = 0;
  let expectedLength = 3;
  try {
    while (length < expectedLength) {
      signal.throwIfAborted();
      const { bytesRead } = await connection.read(buffer, length, expectedLength - length);
      length += bytesRead;
      if (length !== 3 || expectedLength !== 3) continue;
      const functionCode = buffer[1]!;
      if ((functionCode & 0x80) !== 0) expectedLength = 5;
      else if (functionCode === 3 || functionCode === 4) expectedLength = buffer[2]! + 5;
      else return { bytes: buffer.subarray(0, length), complete: false };
      if (expectedLength > buffer.length) return { bytes: buffer.subarray(0, length), complete: false };
    }
    return { bytes: buffer.subarray(0, length), complete: true };
  } catch {
    return { bytes: buffer.subarray(0, length), complete: false };
  }
}

async function requirePinnedPort(driver: SerialDriver, target: ConfiguredModbusSerialTarget): Promise<void> {
  const matching = (await driver.list()).filter(port => port.path === target.path);
  if (matching.length !== 1 || !matchesUsbIdentity(matching[0]!, target)) {
    throw new Error("Configured Modbus serial port is unavailable or has a different identity");
  }
}

function matchesUsbIdentity(port: PortInfo, target: ConfiguredModbusSerialTarget): boolean {
  return port.serialNumber === target.serialNumber && port.vendorId?.toLowerCase() === target.vendorId
    && port.productId?.toLowerCase() === target.productId;
}

function targetIdentity(target: ConfiguredModbusSerialTarget): string {
  return JSON.stringify([target.vendorId, target.productId, target.serialNumber, target.read.unitAddress]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUsbId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{4}$/iu.test(value);
}

function isSerialPath(value: unknown): value is string {
  return typeof value === "string"
    && (/^\/dev\/(?:tty|cu\.)[a-zA-Z0-9._-]{1,128}$/u.test(value) || /^COM[1-9][0-9]{0,3}$/iu.test(value));
}

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
