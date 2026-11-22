import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { DeviceBrokerError } from "@ling-stack/core";
import type { AndroidAdbInventory, AndroidAdbTarget, AndroidAdbTargetExecutor, AndroidPackageInfo } from "./adapters/android-adb.js";
import { localProcessRunner, type LocalProcessRunner } from "./adapters/local-pc-executor.js";
import { isRecord } from "../../shared/validation.js";

interface AdbTargetConfig {
  readonly connectionId: string;
  readonly adbSerial: string;
  readonly hardwareSerial: string;
  readonly kind: AndroidAdbTarget["kind"];
}

export interface BoundAndroidAdbTarget extends AndroidAdbTarget {
  readonly connectionId: string;
  readonly deviceId: string;
}

const targetFields = new Set(["connectionId", "adbSerial", "hardwareSerial", "kind"]);
const hardwareSerialCommand = [
  "serial=$(getprop ro.serialno)",
  '[ -n "$serial" ] || serial=$(getprop ro.boot.serialno)',
  'printf "%s\\n" "$serial"',
].join("; ");
const inventoryCommand = ["ro.product.model", "ro.build.version.release", "ro.build.fingerprint"]
  .map(property => `getprop ${property}`).join("; ");
const adbServer = ["-H", "localhost", "-P", "5037"];

export function readAndroidAdbTargets(path: string | undefined, runner: LocalProcessRunner = localProcessRunner): readonly BoundAndroidAdbTarget[] {
  if (path === undefined) return [];
  let document: unknown;
  try {
    if (!isAbsolute(path)) throw new Error();
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error();
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Android ADB target configuration requires an absolute path to a readable JSON file");
  }
  if (!isRecord(document) || document.version !== 1 || !Array.isArray(document.targets) || document.targets.length > 32
    || Object.keys(document).some(key => key !== "version" && key !== "adbPath" && key !== "targets")) {
    throw new Error("Android ADB target configuration requires version 1 and at most 32 targets");
  }
  const adbPath = document.adbPath ?? (process.platform === "win32" ? "adb.exe" : "adb");
  if (typeof adbPath !== "string" || (document.adbPath !== undefined
    && (!isAbsolute(adbPath) || adbPath.length > 1024 || /[\u0000-\u001f\u007f]/u.test(adbPath)))) {
    throw new Error("Android ADB executable path must be absolute");
  }
  const targets = document.targets.map(parseTarget);
  for (const field of ["connectionId", "adbSerial", "hardwareSerial"] as const) {
    if (new Set(targets.map(target => target[field])).size !== targets.length) {
      throw new Error("Android ADB target connection IDs and serials must be unique");
    }
  }
  return targets.map(target => {
    const identity = sha256(target.hardwareSerial);
    return {
      connectionId: target.connectionId, connectionRef: `adb-target:${target.connectionId}`, kind: target.kind,
      deviceId: `adb:${identity}`, executor: new AndroidAdbProcessExecutor(target, identity, adbPath, runner),
    };
  });
}

function parseTarget(value: unknown, index: number): AdbTargetConfig {
  if (!isRecord(value) || Object.keys(value).some(key => !targetFields.has(key))
    || typeof value.connectionId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.connectionId)
    || typeof value.adbSerial !== "string" || !/^[a-zA-Z0-9:._%\-\[\]]{1,256}$/u.test(value.adbSerial)
    || typeof value.hardwareSerial !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.hardwareSerial)
    || (value.kind !== "android" && value.kind !== "head_unit")) {
    throw new Error(`Invalid Android ADB target at index ${index}`);
  }
  return { connectionId: value.connectionId, adbSerial: value.adbSerial, hardwareSerial: value.hardwareSerial, kind: value.kind };
}

class AndroidAdbProcessExecutor implements AndroidAdbTargetExecutor {
  readonly #connectionEpoch = randomUUID();

  constructor(private readonly target: AdbTargetConfig, private readonly identity: string,
    private readonly file: string, private readonly runner: LocalProcessRunner) {}

  async inventory(parent?: AbortSignal): Promise<AndroidAdbInventory> {
    const { inventory } = await this.#read(parent);
    return inventory;
  }

  async readPackages(parent?: AbortSignal, revision?: string): Promise<readonly AndroidPackageInfo[]> {
    const { inventory, selector, signal, fingerprint } = await this.#read(parent);
    if (inventory.connectionRevision !== revision) {
      throw new DeviceBrokerError("target_changed", "Android ADB transport changed before package readback");
    }
    // Check identity in the same shell as the package query. ADB transport IDs
    // can be reassigned when the ADB server restarts.
    const script = `${hardwareSerialCommand}; getprop ro.build.fingerprint; if [ "$serial" = '${this.target.hardwareSerial}' ]; then pm list packages; fi`;
    const [serial, currentFingerprint, ...lines] = (await this.#run([...selector, script], signal)).split(/\r?\n/u);
    this.#assertSerial(serial);
    if (fingerprint !== currentFingerprint) throw new DeviceBrokerError("target_changed", "Android build changed during package readback");
    return parsePackages(lines);
  }

  async #read(parent?: AbortSignal) {
    const timeout = AbortSignal.timeout(6_000);
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    const devices = await this.#run(["devices", "-l"], signal);
    const rows = devices.split(/\r?\n/u).map(line => line.trim().split(/\s+/u)).filter(([serial]) => serial === this.target.adbSerial);
    if (rows.length !== 1) throw new DeviceBrokerError("connection_failed", "configured Android ADB transport is unavailable");
    const row = rows[0]!;
    if (row[1] === "unauthorized") throw new DeviceBrokerError("authentication_required", "confirm the PC ADB key on the Android device");
    const transportId = row.find(part => /^transport_id:[1-9]\d{0,15}$/u.test(part))?.slice("transport_id:".length);
    if (row[1] !== "device" || !transportId) {
      throw new DeviceBrokerError("connection_failed", "configured ADB transport is offline or lacks a transport ID");
    }
    const selector = ["-t", transportId, "shell", "-T"];
    const output = await this.#run([...selector, `${hardwareSerialCommand}; ${inventoryCommand}`], signal);
    const [serial, model, release, fingerprint] = output.split(/\r?\n/u);
    this.#assertSerial(serial);
    if (!model?.trim() || model.length > 128 || /[\u0000-\u001f\u007f]/u.test(model)
      || !fingerprint || fingerprint.length > 512 || /[\u0000-\u001f\u007f]/u.test(fingerprint)) {
      throw new DeviceBrokerError("connection_failed", "Android ADB returned an invalid inventory");
    }
    const connectionRevision = sha256(JSON.stringify([this.#connectionEpoch, this.target.adbSerial, transportId, fingerprint]));
    const androidVersion = release && /^\d{1,3}(?:\.\d{1,3}){0,3}$/u.test(release) ? release : undefined;
    return { inventory: { serial: this.identity, model, androidVersion, connectionRevision }, selector, signal, fingerprint };
  }

  #assertSerial(serial: string | undefined): void {
    if (serial !== this.target.hardwareSerial) {
      throw new DeviceBrokerError("target_changed", "Android hardware serial differs from the enrolled target");
    }
  }

  async #run(args: readonly string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const result = await this.runner.run(this.file, [...adbServer, ...args], signal);
    signal.throwIfAborted();
    if (result.exitCode !== 0) throw new DeviceBrokerError("connection_failed", "the local ADB tool did not complete the operation");
    return result.stdout;
  }
}

function parsePackages(lines: readonly string[]): readonly AndroidPackageInfo[] {
  const packages = new Set<string>();
  for (const line of lines) {
    if (!line) continue;
    const match = /^package:([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)$/u.exec(line);
    if (!match || match[1]!.length > 255 || packages.size >= 2_048) {
      throw new DeviceBrokerError("connection_failed", "Android package inventory is malformed or exceeds its budget");
    }
    packages.add(match[1]!);
  }
  return Array.from(packages, packageId => ({ packageId }));
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
