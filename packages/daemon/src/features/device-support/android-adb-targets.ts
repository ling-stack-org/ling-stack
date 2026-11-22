import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { DeviceBrokerError } from "@ling-stack/core";
import { isAndroidPackageId, isAndroidVersionCode, type AndroidAdbInventory, type AndroidAdbTarget,
  type AndroidAdbTargetExecutor, type AndroidPackageInfo } from "./adapters/android-adb.js";
import { localProcessRunner, type LocalProcessInput, type LocalProcessRunner } from "./adapters/local-pc-executor.js";
import { AndroidApkLibrary, type AndroidApkTools } from "./android-apks.js";
import { isRecord } from "../../shared/validation.js";

interface AdbTargetConfig {
  readonly connectionId: string;
  readonly adbSerial: string;
  readonly hardwareSerial: string;
  readonly kind: AndroidAdbTarget["kind"];
  readonly logTag?: string;
}

export interface BoundAndroidAdbTarget extends AndroidAdbTarget {
  readonly connectionId: string;
  readonly deviceId: string;
}

interface AndroidAdbConfiguration {
  readonly adbPath: string;
  readonly targets: readonly AdbTargetConfig[];
  readonly apkTools?: AndroidApkTools;
}

const targetFields = new Set(["connectionId", "adbSerial", "hardwareSerial", "kind", "logTag"]);
const hardwareSerialCommand = [
  "serial=$(getprop ro.serialno)",
  '[ -n "$serial" ] || serial=$(getprop ro.boot.serialno)',
  'printf "%s\\n" "$serial"',
].join("; ");
const inventoryCommand = ["ro.product.model", "ro.build.version.release", "ro.build.fingerprint"]
  .map(property => `getprop ${property}`).join("; ");
const packagesCommand = 'if packages=$(pm list packages --show-versioncode 2>/dev/null); then printf "%s\\n" "$packages"; else pm list packages; fi';
const adbServer = ["-H", "localhost", "-P", "5037"];

export function readAndroidAdbConfiguration(path: string | undefined): AndroidAdbConfiguration | undefined {
  if (path === undefined) return undefined;
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
    || Object.keys(document).some(key => key !== "version" && key !== "adbPath" && key !== "targets" && key !== "apkTools")) {
    throw new Error("Android ADB target configuration requires version 1 and at most 32 targets");
  }
  const adbPath = document.adbPath ?? (process.platform === "win32" ? "adb.exe" : "adb");
  if (typeof adbPath !== "string" || (document.adbPath !== undefined && !isConfiguredPath(adbPath))) {
    throw new Error("Android ADB executable path must be absolute");
  }
  const apkTools = document.apkTools === undefined ? undefined : parseApkTools(document.apkTools);
  const targets = document.targets.map(parseTarget);
  for (const field of ["connectionId", "adbSerial", "hardwareSerial"] as const) {
    if (new Set(targets.map(target => target[field])).size !== targets.length) {
      throw new Error("Android ADB target connection IDs and serials must be unique");
    }
  }
  return { adbPath, targets, apkTools };
}

export function bindAndroidAdbTargets(
  configuration: AndroidAdbConfiguration | undefined, artifactDirectory: string, runner: LocalProcessRunner = localProcessRunner,
): { readonly targets: readonly BoundAndroidAdbTarget[]; readonly apks?: AndroidApkLibrary } {
  if (!configuration) return { targets: [] };
  const { adbPath, targets, apkTools } = configuration;
  const apks = apkTools ? new AndroidApkLibrary(artifactDirectory, apkTools, runner) : undefined;
  return { apks, targets: targets.map(target => {
    const identity = sha256(target.hardwareSerial);
    return {
      connectionId: target.connectionId, connectionRef: `adb-target:${target.connectionId}`, kind: target.kind,
      deviceId: `adb:${identity}`, executor: new AndroidAdbProcessExecutor(target, identity, adbPath, runner, apks),
    };
  }) };
}

function parseApkTools(value: unknown): AndroidApkTools {
  if (!isRecord(value) || Object.keys(value).length !== 3 || !isConfiguredPath(value.javaPath)
    || !isConfiguredPath(value.apkSignerJar) || !isConfiguredPath(value.aapt2Path)) {
    throw new Error("Android APK tools require absolute javaPath, apkSignerJar and aapt2Path");
  }
  return { javaPath: value.javaPath, apkSignerJar: value.apkSignerJar, aapt2Path: value.aapt2Path };
}

function isConfiguredPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseTarget(value: unknown, index: number): AdbTargetConfig {
  if (!isRecord(value) || Object.keys(value).some(key => !targetFields.has(key))
    || typeof value.connectionId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.connectionId)
    || typeof value.adbSerial !== "string" || !/^[a-zA-Z0-9:._%\-\[\]]{1,256}$/u.test(value.adbSerial)
    || typeof value.hardwareSerial !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.hardwareSerial)
    || (value.kind !== "android" && value.kind !== "head_unit")
    || (value.logTag !== undefined && (typeof value.logTag !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/u.test(value.logTag)))) {
    throw new Error(`Invalid Android ADB target at index ${index}`);
  }
  return { connectionId: value.connectionId, adbSerial: value.adbSerial, hardwareSerial: value.hardwareSerial, kind: value.kind, logTag: value.logTag };
}

class AndroidAdbProcessExecutor implements AndroidAdbTargetExecutor {
  readonly #connectionEpoch = randomUUID();
  readonly readLogs?: AndroidAdbTargetExecutor["readLogs"];
  readonly installArtifact?: AndroidAdbTargetExecutor["installArtifact"];

  constructor(private readonly target: AdbTargetConfig, private readonly identity: string,
    private readonly file: string, private readonly runner: LocalProcessRunner, apks?: AndroidApkLibrary) {
    const tag = target.logTag;
    if (tag !== undefined) {
      this.readLogs = async input => {
        if (input.tag !== undefined && input.tag !== tag) throw new DeviceBrokerError("permission_denied", "ADB log tag differs from the configured application tag");
        const lines = await this.#query(`logcat -b main -b crash -d -t 200 -v threadtime '${tag}:V' '*:S'`, input.connectionRevision, input.signal);
        return lines.join("\n");
      };
    }
    if (apks) {
      this.installArtifact = async input => {
        const signal = input.signal ?? AbortSignal.timeout(60_000);
        return await apks.withApk(input.artifactDigest, signal, async (source, size) => {
          const { inventory, selector, fingerprint } = await this.#read(signal);
          this.#assertRevision(inventory, input.connectionRevision);
          const ready = "ling-apk-input-ready";
          const command = [
            `printf '%s\\n' '${ready}'`,
            // Android's package argument parser treats a bare dash as an option.
            `pm install -r -S ${size} -- - 2>&1`,
            'result=$?',
            'printf "\\nling-apk-result:%s\\n" "$result"',
          ].join("; ");
          const readyPrefix = `${this.target.hardwareSerial}\n${fingerprint}\n${ready}\n`;
          const output = await this.#run([...selector, this.#boundScript(command, fingerprint)], signal, { source, readyPrefix });
          if (!output.startsWith(readyPrefix)) throw new DeviceBrokerError("target_changed", "APK upload target identity changed");
          const lines = output.slice(readyPrefix.length).trim().split(/\r?\n/u);
          const receipt = lines.pop();
          if (receipt === "ling-apk-result:0" && lines.some(line => line === "Success")) {
            return { accepted: true, packageId: input.packageId, versionCode: input.versionCode };
          }
          if (/^ling-apk-result:[1-9]\d*$/u.test(receipt ?? "") && lines.some(line => /^Failure \[.+\]$/u.test(line))) {
            return { accepted: false };
          }
          throw new DeviceBrokerError("unknown_outcome", "Android did not return a package installation result");
        });
      };
    }
  }

  async inventory(parent?: AbortSignal): Promise<AndroidAdbInventory> {
    const { inventory } = await this.#read(parent);
    return inventory;
  }

  async readPackages(parent?: AbortSignal, revision?: string): Promise<readonly AndroidPackageInfo[]> {
    return parsePackages(await this.#query(packagesCommand, revision, parent));
  }

  async readPackage(packageId: string, parent: AbortSignal | undefined, revision: string): Promise<AndroidPackageInfo | undefined> {
    if (!isAndroidPackageId(packageId)) throw new DeviceBrokerError("invalid_request", "Invalid Android package ID");
    const listed = (await this.readPackages(parent, revision)).find(item => item.packageId === packageId);
    if (!listed) return undefined;
    const versionCode = listed.versionCode ?? await this.#readPackageVersion(packageId, revision, parent);
    if (versionCode === undefined) return listed;
    const digestCommand = [
      `paths=$(pm path ${packageId} 2>/dev/null)`,
      "apk=",
      'case "$paths" in package:/*) apk=${paths#package:};; esac',
      'if [ -n "$apk" ] && [ -f "$apk" ]; then digest=$(sha256sum "$apk" 2>/dev/null) && printf "%s\\n" "${digest%% *}"; fi',
    ].join("; ");
    const [digest] = await this.#query(digestCommand, revision, parent);
    return { packageId, versionCode, ...(digest && /^[0-9a-f]{64}$/u.test(digest) ? { artifactDigest: "sha256:" + digest } : {}) };
  }

  async #readPackageVersion(packageId: string, revision: string, parent?: AbortSignal): Promise<string | undefined> {
    const lines = await this.#query(`dumpsys package ${packageId}`, revision, parent);
    const start = lines.findIndex(line => line.trim().startsWith(`Package [${packageId}] (`));
    if (start < 0) return undefined;
    for (const line of lines.slice(start + 1)) {
      if (/^\s*Package \[/u.test(line) || /^\S/u.test(line)) break;
      const match = /^\s+versionCode=(\d+)(?:\s|$)/u.exec(line);
      if (isAndroidVersionCode(match?.[1])) return match[1];
    }
    return undefined;
  }

  async #query(command: string, revision: string | undefined, parent?: AbortSignal): Promise<readonly string[]> {
    const { inventory, selector, signal, fingerprint } = await this.#read(parent);
    this.#assertRevision(inventory, revision);
    const [serial, actualFingerprint, ...lines] = (await this.#run([...selector, this.#boundScript(command, fingerprint)], signal)).split(/\r?\n/u);
    this.#assertSerial(serial);
    if (actualFingerprint !== fingerprint) throw new DeviceBrokerError("target_changed", "Android build changed during the operation");
    return lines;
  }

  #boundScript(command: string, fingerprint: string): string {
    // The query and identity check share a shell because the server can reassign transport IDs.
    const expectedFingerprint = "'" + fingerprint.replaceAll("'", "'\\''") + "'";
    return [
      hardwareSerialCommand,
      "fingerprint=$(getprop ro.build.fingerprint)",
      'printf "%s\\n" "$fingerprint"',
      `if [ "$serial" = '${this.target.hardwareSerial}' ] && [ "$fingerprint" = ${expectedFingerprint} ]; then ${command}; fi`,
    ].join("; ");
  }

  #assertRevision(inventory: AndroidAdbInventory, revision: string | undefined): void {
    if (inventory.connectionRevision !== revision) {
      throw new DeviceBrokerError("target_changed", "Android ADB transport changed before the operation");
    }
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

  async #run(args: readonly string[], signal: AbortSignal, input?: LocalProcessInput): Promise<string> {
    signal.throwIfAborted();
    const result = await this.runner.run(this.file, [...adbServer, ...args], signal, input);
    signal.throwIfAborted();
    if (result.exitCode !== 0) throw new DeviceBrokerError("connection_failed", "the local ADB tool did not complete the operation");
    if (Buffer.byteLength(result.stdout, "utf8") > 256 * 1024) {
      throw new DeviceBrokerError("connection_failed", "Android ADB output exceeded its size limit");
    }
    return result.stdout;
  }
}

function parsePackages(lines: readonly string[]): readonly AndroidPackageInfo[] {
  const packages = new Map<string, AndroidPackageInfo>();
  for (const line of lines) {
    if (!line) continue;
    const match = /^package:([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)(?: versionCode:(\d+))?$/u.exec(line);
    const packageId = match?.[1];
    const versionCode = match?.[2];
    if (!packageId || packageId.length > 255 || packages.size >= 2_048
      || (versionCode !== undefined && !isAndroidVersionCode(versionCode))) {
      throw new DeviceBrokerError("connection_failed", "Android package inventory is malformed or exceeds its budget");
    }
    const previous = packages.get(packageId);
    if (previous && previous.versionCode !== versionCode) {
      throw new DeviceBrokerError("connection_failed", "Android package inventory reports competing version codes");
    }
    packages.set(packageId, { packageId, ...(versionCode !== undefined ? { versionCode } : {}) });
  }
  return [...packages.values()];
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
