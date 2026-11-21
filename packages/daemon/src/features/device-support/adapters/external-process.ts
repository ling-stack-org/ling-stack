import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  isDeviceActionResultV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceObservationV1,
  isDeviceProfileV1,
  isDeviceVerificationResultV1,
  type AdapterManifestV1,
  type DeviceActionResultV1,
  type DeviceCapabilitySnapshotV1,
  type DeviceProfileV1,
  type DeviceVerificationResultV1,
} from "@ling-stack/contracts";
import {
  DeviceBrokerError,
  type DeviceAdapter,
  type DeviceAdapterDiscoveryInput,
  type DeviceAdapterExecutionResult,
  type DeviceAdapterVerificationInput,
  type DeviceAdapterVerificationResult,
} from "@ling-stack/core";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 16;

type AdapterChild = ChildProcessByStdio<Writable, Readable, null>;
type AdapterPayloads = {
  discover: Omit<DeviceAdapterDiscoveryInput, "signal">;
  get_capabilities: Omit<Parameters<DeviceAdapter["getCapabilities"]>[0], "signal">;
  execute: Omit<Parameters<DeviceAdapter["execute"]>[0], "signal">;
  verify: Omit<DeviceAdapterVerificationInput, "signal">;
};
type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly dispose: () => void;
};

export interface ExternalAdapterProcessOptions {
  readonly manifest: AdapterManifestV1;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}

/** Runs a trusted adapter over a bounded JSON Lines connection. */
export class ExternalDeviceAdapter implements DeviceAdapter {
  readonly manifest: AdapterManifestV1;
  readonly #options: ExternalAdapterProcessOptions;
  readonly #timeoutMs: number;
  readonly #frameLimit: number;
  readonly #pending = new Map<string, PendingRequest>();
  #child?: AdapterChild;
  #stdoutBuffer = "";
  #closed = false;

  constructor(options: ExternalAdapterProcessOptions) {
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#frameLimit = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    if (!isAbsolute(options.command) || !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(this.#frameLimit) || this.#frameLimit < 1024 || this.#frameLimit > MAX_FRAME_BYTES) {
      throw new DeviceBrokerError("invalid_request", "external adapter launch options are invalid");
    }
    this.manifest = options.manifest;
    this.#options = options;
  }

  async discover({ signal, ...payload }: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const result = await this.request("discover", payload, signal);
    if (!isDeviceProfileV1(result)) throw invalidResponse();
    return result;
  }

  async getCapabilities({ signal, ...payload }: Parameters<DeviceAdapter["getCapabilities"]>[0]): Promise<DeviceCapabilitySnapshotV1> {
    const result = await this.request("get_capabilities", payload, signal);
    if (!isDeviceCapabilitySnapshotV1(result)) throw invalidResponse();
    return result;
  }

  async execute({ signal, ...payload }: Parameters<DeviceAdapter["execute"]>[0]): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    const result = await this.request("execute", payload, signal, payload.capability);
    if (isDeviceActionResultV1(result) && result.actionId === payload.request.actionId) return result;
    if (!isRecord(result) || !isDeviceActionResultV1(result.action) || result.action.actionId !== payload.request.actionId) throw invalidResponse();
    return { action: result.action, observations: readObservations(result.observations) };
  }

  async verify({ signal, ...payload }: DeviceAdapterVerificationInput): Promise<DeviceVerificationResultV1 | DeviceAdapterVerificationResult> {
    const result = await this.request("verify", payload, signal, payload.capability);
    if (isDeviceVerificationResultV1(result) && result.actionId === payload.request.actionId) return result;
    if (!isRecord(result) || !isDeviceVerificationResultV1(result.verification) || result.verification.actionId !== payload.request.actionId) throw invalidResponse();
    return { verification: result.verification, observations: readObservations(result.observations) };
  }

  close(): void {
    this.#closed = true;
    if (this.#child) this.reset(this.#child, new DeviceBrokerError("connection_failed", "external adapter is closed"));
  }

  private async request<M extends keyof AdapterPayloads>(
    method: M, payload: AdapterPayloads[M], signal?: AbortSignal,
    limits?: { readonly timeoutMs: number; readonly responseBytesLimit: number },
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.#closed) throw new DeviceBrokerError("connection_failed", "external adapter is closed");
    if (this.#pending.size >= MAX_PENDING_REQUESTS) throw new DeviceBrokerError("target_busy", "external adapter request queue is full");
    const requestId = randomUUID();
    const line = JSON.stringify({ protocol: PROTOCOL_VERSION, requestId, method, payload }) + "\n";
    if (Buffer.byteLength(line) > this.#frameLimit) throw new DeviceBrokerError("invalid_request", "external adapter request exceeds the frame limit");

    const child = this.#child ?? this.startChild();
    const failure = new DeviceBrokerError("connection_failed", "external adapter connection ended");
    return await new Promise((resolve, reject) => {
      const abort = () => this.reset(child, new DOMException("external adapter request aborted", "AbortError"));
      const timer = setTimeout(() => {
        this.reset(child, new DeviceBrokerError("timeout", "external adapter request timed out"));
      }, Math.min(this.#timeoutMs, limits?.timeoutMs ?? this.#timeoutMs));
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(requestId, {
        resolve: result => {
          if (limits && Buffer.byteLength(JSON.stringify(result) ?? "") > limits.responseBytesLimit) {
            this.reset(child, invalidResponse());
            reject(invalidResponse());
          } else {
            resolve(result);
          }
        },
        reject,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      child.stdin.write(line, error => { if (error) this.reset(child, failure); });
    });
  }

  private startChild(): AdapterChild {
    const child = spawn(this.#options.command, [...(this.#options.args ?? [])], {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env, LING_DEVICE_ADAPTER_PROTOCOL: String(PROTOCOL_VERSION) },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.#child = child;
    const connectionEnded = () => this.reset(child, new DeviceBrokerError("connection_failed", "external adapter connection ended"));
    child.on("error", connectionEnded);
    child.on("close", connectionEnded);
    child.stdin.on("error", connectionEnded);
    child.stdout.on("error", connectionEnded);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.readStdout(child, chunk));
    return child;
  }

  private readStdout(child: AdapterChild, chunk: string): void {
    if (child !== this.#child) return;
    this.#stdoutBuffer += chunk;
    let newline = this.#stdoutBuffer.indexOf("\n");
    while (newline >= 0 && child === this.#child) {
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.#frameLimit) {
        this.reset(child, invalidResponse());
        return;
      }
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        this.reset(child, invalidResponse());
        return;
      }
      if (!isRecord(response) || response.protocol !== PROTOCOL_VERSION || typeof response.requestId !== "string"
        || typeof response.ok !== "boolean" || (response.ok && !Object.hasOwn(response, "result"))) {
        this.reset(child, invalidResponse());
        return;
      }
      const pending = this.#pending.get(response.requestId);
      if (!pending) {
        this.reset(child, invalidResponse());
        return;
      }
      this.#pending.delete(response.requestId);
      pending.dispose();
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new DeviceBrokerError("service_unavailable", "external adapter rejected the operation"));
      newline = this.#stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#stdoutBuffer) > this.#frameLimit) this.reset(child, invalidResponse());
  }

  private reset(child: AdapterChild, error: Error): void {
    if (child !== this.#child) return;
    this.#child = undefined;
    this.#stdoutBuffer = "";
    for (const pending of this.#pending.values()) {
      pending.dispose();
      pending.reject(error);
    }
    this.#pending.clear();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
  }
}

function invalidResponse(): DeviceBrokerError {
  return new DeviceBrokerError("connection_failed", "external adapter response is invalid or exceeds its size limit");
}

function readObservations(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isDeviceObservationV1)) throw invalidResponse();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
