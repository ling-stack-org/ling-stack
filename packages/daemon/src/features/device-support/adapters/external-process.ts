import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  isDeviceActionResultV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceObservationV1,
  isDeviceProfileV1,
  isDeviceVerificationResultV1,
  type AdapterManifestV1,
  type DeviceActionRequestV1,
  type DeviceActionResultV1,
  type DeviceCapabilitySnapshotV1,
  type DeviceObservationV1,
  type DeviceProfileV1,
  type DeviceVerificationResultV1,
  type JsonValue,
} from "@ling-stack/contracts";
import type {
  DeviceAdapter,
  DeviceAdapterDiscoveryInput,
  DeviceAdapterExecutionResult,
  DeviceAdapterVerificationInput,
  DeviceAdapterVerificationResult,
} from "@ling-stack/core";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

type AdapterMethod = "discover" | "get_capabilities" | "execute" | "verify";

interface AdapterRequest {
  readonly protocol: 1;
  readonly requestId: string;
  readonly method: AdapterMethod;
  readonly payload: JsonValue;
}

interface AdapterResponse {
  readonly protocol: 1;
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code?: string };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanup: () => void;
}

export interface ExternalAdapterProcessOptions {
  readonly manifest: AdapterManifestV1;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}

/**
 * Hosts an adapter behind a newline-delimited JSON process boundary. A failed
 * child is discarded with its pending requests, and the next operation starts
 * a fresh child. The broker remains responsible for recording uncertain writes.
 */
export class ExternalDeviceAdapter implements DeviceAdapter {
  readonly manifest: AdapterManifestV1;
  readonly #options: ExternalAdapterProcessOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #child?: ChildProcessWithoutNullStreams;
  #stdoutBuffer = "";
  #closed = false;

  constructor(options: ExternalAdapterProcessOptions) {
    if (!options.command.trim()) throw new Error("external adapter command is required");
    if (!Number.isInteger(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS) || (options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS) < 1) {
      throw new Error("external adapter timeout is invalid");
    }
    if (!Number.isInteger(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES) || (options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES) < 1024) {
      throw new Error("external adapter frame limit is invalid");
    }
    this.manifest = options.manifest;
    this.#options = options;
  }

  async discover(input: DeviceAdapterDiscoveryInput): Promise<DeviceProfileV1> {
    const result = await this.request("discover", {
      connectionRef: input.connectionRef,
      ownerId: input.ownerId,
    });
    if (!isDeviceProfileV1(result)) throw new ExternalAdapterProcessError("invalid_response");
    return result;
  }

  async getCapabilities(input: {
    readonly profile: DeviceProfileV1;
    readonly connectionRevision: string;
    readonly signal?: AbortSignal;
  }): Promise<DeviceCapabilitySnapshotV1> {
    const result = await this.request("get_capabilities", {
      profile: input.profile,
      connectionRevision: input.connectionRevision,
    } as unknown as JsonValue, input.signal);
    if (!isDeviceCapabilitySnapshotV1(result)) throw new ExternalAdapterProcessError("invalid_response");
    return result;
  }

  async execute(input: {
    readonly profile: DeviceProfileV1;
    readonly capability: import("@ling-stack/contracts").CapabilityDescriptorV1;
    readonly request: DeviceActionRequestV1;
    readonly signal?: AbortSignal;
  }): Promise<DeviceActionResultV1 | DeviceAdapterExecutionResult> {
    const result = await this.request("execute", {
      profile: input.profile,
      capability: input.capability,
      request: input.request,
    } as unknown as JsonValue, input.signal);
    return readExecutionResult(result, input.request.actionId);
  }

  readonly verify = async (input: DeviceAdapterVerificationInput): Promise<DeviceVerificationResultV1 | DeviceAdapterVerificationResult> => {
    const result = await this.request("verify", {
      profile: input.profile,
      capability: input.capability,
      request: input.request,
      action: input.action,
      evidenceId: input.evidenceId,
    } as unknown as JsonValue, input.signal);
    return readVerificationResult(result, input.request.actionId);
  };

  close(): void {
    this.#closed = true;
    this.reset(new ExternalAdapterProcessError("adapter_closed"));
  }

  private request(method: AdapterMethod, payload: JsonValue, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ExternalAdapterProcessError("adapter_closed"));
    const child = this.ensureChild();
    const requestId = randomUUID();
    const timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const message: AdapterRequest = { protocol: PROTOCOL_VERSION, requestId, method, payload };
    return new Promise((resolve, reject) => {
      let cleanup = () => {};
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        cleanup();
        this.reset(new ExternalAdapterProcessError("adapter_timeout"));
        reject(new ExternalAdapterProcessError("adapter_timeout"));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(requestId);
        this.reset(new ExternalAdapterProcessError("adapter_aborted"));
        reject(new ExternalAdapterProcessError("adapter_aborted"));
      };
      cleanup = () => signal?.removeEventListener("abort", abort);
      this.#pending.set(requestId, { resolve, reject, timer, cleanup });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      const line = `${JSON.stringify(message)}\n`;
      try {
        child.stdin.write(line);
      } catch {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(requestId);
        this.reset(new ExternalAdapterProcessError("adapter_write_failed"));
        reject(new ExternalAdapterProcessError("adapter_write_failed"));
      }
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.#child) return this.#child;
    const env = { ...process.env, ...this.#options.env, LING_DEVICE_ADAPTER_PROTOCOL: String(PROTOCOL_VERSION) };
    const child = spawn(this.#options.command, [...(this.#options.args ?? [])], {
      cwd: this.#options.cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.readStdout(String(chunk)));
    child.on("error", () => this.reset(new ExternalAdapterProcessError("adapter_process_error")));
    child.on("exit", () => this.reset(new ExternalAdapterProcessError("adapter_exited"), child));
    return child;
  }

  private readStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    const limit = this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > limit) {
      this.reset(new ExternalAdapterProcessError("adapter_frame_too_large"));
      return;
    }
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > limit) {
        this.reset(new ExternalAdapterProcessError("adapter_frame_too_large"));
        return;
      }
      let response: AdapterResponse;
      try {
        response = JSON.parse(line) as AdapterResponse;
      } catch {
        this.reset(new ExternalAdapterProcessError("adapter_invalid_frame"));
        return;
      }
      if (response.protocol !== PROTOCOL_VERSION || typeof response.requestId !== "string" || typeof response.ok !== "boolean") {
        this.reset(new ExternalAdapterProcessError("adapter_invalid_frame"));
        return;
      }
      const pending = this.#pending.get(response.requestId);
      if (!pending) continue;
      this.#pending.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.cleanup();
      if (!response.ok) pending.reject(new ExternalAdapterProcessError(response.error?.code ?? "adapter_rejected"));
      else pending.resolve(response.result);
    }
  }

  private reset(error: Error, exitedChild?: ChildProcessWithoutNullStreams): void {
    const child = this.#child;
    if (exitedChild && child !== exitedChild) return;
    this.#child = undefined;
    this.#stdoutBuffer = "";
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(error);
      this.#pending.delete(requestId);
    }
    if (child && !child.killed) child.kill();
  }
}

export class ExternalAdapterProcessError extends Error {
  constructor(readonly code: string) {
    super(`external adapter process ${code}`);
    this.name = "ExternalAdapterProcessError";
  }
}

function readExecutionResult(value: unknown, actionId: string): DeviceActionResultV1 | DeviceAdapterExecutionResult {
  if (isDeviceActionResultV1(value) && value.actionId === actionId) return value;
  if (!isRecord(value) || !isDeviceActionResultV1(value.action) || value.action.actionId !== actionId) {
    throw new ExternalAdapterProcessError("invalid_action_response");
  }
  const observations = value.observations;
  if (observations !== undefined && (!Array.isArray(observations) || !observations.every(isDeviceObservationV1))) {
    throw new ExternalAdapterProcessError("invalid_action_observations");
  }
  return { action: value.action, ...(observations ? { observations } : {}) };
}

function readVerificationResult(value: unknown, actionId: string): DeviceVerificationResultV1 | DeviceAdapterVerificationResult {
  if (isDeviceVerificationResultV1(value) && value.actionId === actionId) return value;
  if (!isRecord(value) || !isDeviceVerificationResultV1(value.verification) || value.verification.actionId !== actionId) {
    throw new ExternalAdapterProcessError("invalid_verification_response");
  }
  const observations = value.observations;
  if (observations !== undefined && (!Array.isArray(observations) || !observations.every(isDeviceObservationV1))) {
    throw new ExternalAdapterProcessError("invalid_verification_observations");
  }
  return { verification: value.verification, ...(observations ? { observations } : {}) };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
