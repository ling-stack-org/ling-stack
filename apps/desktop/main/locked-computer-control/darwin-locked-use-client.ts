import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { isLockedComputerControlGrantV1, type LockedComputerControlGrantV1 } from "@ling-stack/contracts";
import {
  parseLockedControlNativeSessionResponse,
  parseLockedControlNativeStatusResponse,
  type LockedControlNativeSessionResponse,
  type LockedControlNativeStatusResponse,
} from "./native-helper-bridge.js";
import type { LockedControlNativeIdentityRequest } from "./native-bridge.js";

export interface DarwinLockedUseTaskBinding {
  readonly grantID: string;
  readonly runID: string;
  readonly computerUseSessionID: string;
  readonly desktopInstanceID: string;
  readonly sessionBindingDigest: string;
  readonly lockEpoch: number;
  readonly providerGeneration: number;
  readonly expiresAt: string;
}

/** One verified helper, one local consent and one grant. No token is persisted. */
export class DarwinLockedUseNativeClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private tail: Promise<void> = Promise.resolve();
  private pending: {
    id: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  } | undefined;
  private binding: DarwinLockedUseTaskBinding | undefined;
  private invalid = false;
  private revoked = false;
  private revocationReported = false;
  private managed = false;
  private actionActive = false;

  constructor(private readonly options: {
    readonly helperPath: string;
    /** Packaged composition verifies the helper before each spawn. */
    readonly verifyHelper: () => Promise<void>;
    readonly onRevoked: () => void;
    readonly spawn?: (path: string) => ChildProcessWithoutNullStreams;
  }) {
    if (!isAbsolute(options.helperPath)) throw new Error("locked_use_helper_path_not_absolute");
  }

  get ownsManagedSession(): boolean { return this.managed; }

  async readSession(signal: AbortSignal): Promise<LockedControlNativeSessionResponse> {
    const value = parseLockedControlNativeSessionResponse(await this.request("session", signal));
    if (!value || value.platform !== "darwin") return this.fail("locked_use_session_invalid");
    return value;
  }

  async readStatus(signal: AbortSignal): Promise<LockedControlNativeStatusResponse> {
    const value = parseLockedControlNativeStatusResponse(await this.request("status", signal));
    if (!value) return this.fail("locked_use_status_invalid");
    return value;
  }

  verifyIdentity(input: LockedControlNativeIdentityRequest): Promise<unknown> {
    if (input.platform !== "darwin") return Promise.reject(new Error("locked_use_platform_mismatch"));
    return this.request("identity", input.signal, 120_000);
  }

  async begin(grant: LockedComputerControlGrantV1, generation: number, signal: AbortSignal): Promise<void> {
    if (this.binding || !isLockedComputerControlGrantV1(grant) || grant.platform !== "darwin"
      || Date.parse(grant.expiresAt) <= Date.now() || !Number.isSafeInteger(generation)
      || generation <= grant.authorizedNormalGeneration) throw new Error("locked_use_grant_invalid");
    this.binding = Object.freeze({
      grantID: grant.grantId, runID: grant.runId, computerUseSessionID: grant.computerUseSessionId,
      desktopInstanceID: grant.desktopInstanceId, sessionBindingDigest: grant.osSessionBindingDigest,
      lockEpoch: grant.authorizedLockEpoch, providerGeneration: generation, expiresAt: grant.expiresAt,
    });
    this.managed = true;
    const result = await this.request("begin", signal, 30_000);
    if (!isFlag(result, "active")) this.fail("locked_use_begin_denied");
    this.assertBound();
  }

  async check(signal: AbortSignal): Promise<void> {
    this.assertBound();
    if (!isFlag(await this.request("check", signal), "active")) this.fail("locked_use_check_denied");
    this.assertBound();
  }

  async beginAction(signal: AbortSignal): Promise<void> {
    this.assertBound();
    if (this.actionActive) throw new Error("locked_use_action_in_flight");
    this.actionActive = true;
    try {
      if (!isFlag(await this.request("action-begin", signal), "active")) this.fail("locked_use_action_denied");
      this.assertBound();
    } catch (error) {
      this.actionActive = false;
      throw error;
    }
  }

  async finishAction(signal: AbortSignal): Promise<void> {
    if (!this.actionActive) throw new Error("locked_use_action_not_started");
    try {
      if (!isFlag(await this.request("action-end", signal), "active")) this.fail("locked_use_action_denied");
      this.assertBound();
    } finally { this.actionActive = false; }
  }

  /** Call only after the provider has fenced and quiesced every admitted action. */
  async end(): Promise<void> {
    if (this.actionActive) throw new Error("locked_use_provider_not_quiesced");
    if (this.binding) {
      if (this.invalid) throw new Error("locked_use_relock_unconfirmed");
      if (!isFlag(await this.request("end", new AbortController().signal), "ended")) this.fail("locked_use_end_denied");
    }
    this.managed = false;
    this.close();
  }

  close(): void {
    this.invalidate("locked_use_client_closed");
    this.child?.stdin.end();
    this.child?.kill("SIGTERM");
  }

  private assertBound(): void {
    if (!this.binding || !this.ownsManagedSession || this.invalid || this.revoked
      || Date.parse(this.binding.expiresAt) <= Date.now()) {
      this.revoked = true;
      this.reportRevocation();
      throw new Error("locked_use_authority_expired");
    }
  }

  private request(command: string, signal: AbortSignal, timeoutMs = 10_000): Promise<unknown> {
    const pending = this.tail.then(async () => {
      signal.throwIfAborted();
      if (this.invalid) throw new Error("locked_use_client_closed");
      if (!this.child) {
        await this.options.verifyHelper();
        signal.throwIfAborted();
        if (this.invalid) throw new Error("locked_use_client_closed");
        const child = this.options.spawn?.(this.options.helperPath) ?? spawn(this.options.helperPath, [], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        });
        this.child = child;
        child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
        child.stderr.resume();
        child.on("error", () => this.invalidate("locked_use_helper_failed"));
        child.stdin.on("error", () => this.invalidate("locked_use_helper_failed"));
        child.on("close", () => this.invalidate("locked_use_helper_exited"));
      }
      const id = randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const abort = (): void => { this.invalidate("locked_use_request_aborted"); this.child?.kill("SIGKILL"); };
        const timer = setTimeout(() => { this.invalidate("locked_use_request_timeout"); this.child?.kill("SIGKILL"); }, timeoutMs);
        timer.unref();
        const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        this.pending = {
          id,
          resolve(value) { cleanup(); resolve(value); },
          reject(error) { cleanup(); reject(error); },
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        this.child!.stdin.write(`${JSON.stringify({ command, requestId: id,
          ...(this.binding && !["session", "identity"].includes(command) ? { binding: this.binding } : {}),
        })}\n`);
      });
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private receive(chunk: Buffer): void {
    if (this.invalid) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > 16 * 1024) { this.invalidate("locked_use_helper_oversized"); return; }
    while (true) {
      const end = this.buffer.indexOf(10);
      if (end < 0) return;
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      let value: unknown;
      try { value = JSON.parse(line.toString("utf8")); } catch { this.invalidate("locked_use_helper_invalid_json"); return; }
      if (isRecord(value) && value.event === "revoked" && Object.keys(value).length === 1) {
        this.revoked = true;
        this.reportRevocation();
        continue;
      }
      if (!isRecord(value) || !this.pending || value.requestId !== this.pending.id
        || typeof value.ok !== "boolean"
        || Object.keys(value).some((key) => !["requestId", "ok", "result", "reason"].includes(key))) {
        this.invalidate("locked_use_helper_response_invalid"); return;
      }
      const pending = this.pending;
      this.pending = undefined;
      if (value.ok === true) pending.resolve(value.result);
      else {
        this.revoked = true;
        this.reportRevocation();
        pending.reject(new Error("locked_use_native_denied"));
      }
    }
  }

  private fail(reason: string): never { this.invalidate(reason); throw new Error(reason); }

  private invalidate(reason: string): void {
    if (this.invalid) return;
    this.invalid = true;
    this.pending?.reject(new Error(reason));
    this.pending = undefined;
    this.child?.stdin.end();
    if (this.managed) this.reportRevocation();
  }

  private reportRevocation(): void {
    if (this.revocationReported) return;
    this.revocationReported = true;
    try { this.options.onRevoked(); } catch { /* Admission is already closed. */ }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFlag(value: unknown, flag: string): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value[flag] === true;
}
