import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  OFFICE_DRIVER_PROTOCOL,
  officeDriverCapabilities,
  parseOfficeDriverAvailability,
  type OfficeDriverAvailability,
  type OfficeDriverCapability,
  type OfficeDriverPlatform,
  type OfficeDriverRequest,
  type OfficeDriverResult,
  type OfficeDriverRuntimeState,
} from "@ling-stack/contracts";
import { OfficeDriverDaemonClient, type OfficeDriverDaemonTransport } from "./daemon-client.js";
import { OfficeDriverHelperProcess, type OfficeDriverHelper } from "./helper-process.js";

const AVAILABILITY_HEARTBEAT_MS = 5_000;
const ERROR_BACKOFF_MS = 750;

interface HelperStatus {
  readonly helperVersion: string;
  readonly state: OfficeDriverRuntimeState;
  readonly capabilities: readonly OfficeDriverCapability[];
  readonly officeInstalled: boolean;
  readonly applicationRunning: boolean;
  readonly permissionGranted?: boolean;
  readonly errorCode?: string;
}

export class OfficeDriverRuntime {
  private helper: OfficeDriverHelper | undefined;
  private client: OfficeDriverDaemonTransport | undefined;
  private abortController: AbortController | undefined;
  private claimAbortController: AbortController | undefined;
  private claimsPaused = false;
  private pauseRevision = 0;
  private acceptedCommand = false;
  private runPromise: Promise<void> | undefined;
  private helperRecoveryPromise: Promise<void> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private availability: OfficeDriverAvailability | undefined;
  private platformValue: OfficeDriverPlatform | undefined;
  private generation = 0;

  constructor(private readonly options: {
    readonly daemonBaseUrl: string;
    readonly bridgeToken: string;
    readonly desktopInstanceId: string;
    readonly executablePath: string;
    readonly recoveryRoot: string;
    readonly platform?: string;
    readonly helper?: OfficeDriverHelper;
    readonly daemonClientFactory?: (generation: number) => OfficeDriverDaemonTransport;
    readonly now?: () => number;
    readonly onDiagnostic?: (event: string, details?: Readonly<Record<string, unknown>>) => void;
  }) {}

  async start(): Promise<void> {
    if (this.runPromise || this.abortController || this.claimsPaused) return;
    const platform = readPlatform(this.options.platform ?? process.platform);
    if (!platform) return;
    this.platformValue = platform;
    this.generation = Math.max(this.generation + 1, this.now());
    this.abortController = new AbortController();
    this.claimAbortController = new AbortController();
    const signal = this.abortController.signal;
    const claimSignal = this.claimAbortController.signal;
    this.helper = this.options.helper ?? new OfficeDriverHelperProcess({
      executablePath: this.options.executablePath,
      recoveryRoot: this.options.recoveryRoot,
      onDiagnostic: this.options.onDiagnostic,
    });
    this.client = this.options.daemonClientFactory?.(this.generation) ?? new OfficeDriverDaemonClient({
      daemonBaseUrl: this.options.daemonBaseUrl,
      bridgeToken: this.options.bridgeToken,
      desktopInstanceId: this.options.desktopInstanceId,
      generation: this.generation,
    });
    try {
      await this.helper.start();
      if (signal.aborted || this.claimsPaused) return;
      await this.refreshAvailability(platform, claimSignal);
    } catch (error) {
      if (signal.aborted || this.claimsPaused) return;
      this.options.onDiagnostic?.("office_driver.start_failed", { error: safeErrorCode(error) });
      await this.publishSyntheticFailure(platform, safeErrorCode(error), claimSignal);
    }
    if (signal.aborted || this.claimsPaused) return;
    this.runPromise = this.runClaimLoop(signal, claimSignal);
    this.heartbeat = setInterval(() => {
      if (signal.aborted || (this.claimsPaused && !this.acceptedCommand)) return;
      const availabilitySignal = this.acceptedCommand ? signal : claimSignal;
      // A draining accepted command needs its original authority lease, not a
      // new helper health operation or helper-recovery side effect.
      const publication = this.claimsPaused
        ? this.renewAcceptedAvailability(signal)
        : this.refreshAvailability(platform, availabilitySignal);
      void publication.catch((error) => {
        if (availabilitySignal.aborted) return;
        const errorCode = safeErrorCode(error);
        this.options.onDiagnostic?.("office_driver.heartbeat_failed", { error: errorCode });
        if (this.claimsPaused || !shouldRecoverHelper(errorCode)) return;
        return this.recoverHelper().catch((recoveryError) =>
          this.publishSyntheticFailure(platform, safeErrorCode(recoveryError), claimSignal));
      });
    }, AVAILABILITY_HEARTBEAT_MS);
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    this.claimAbortController?.abort();
    this.claimAbortController = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
    await this.helperRecoveryPromise?.catch(() => undefined);
    await this.helper?.stop().catch(() => undefined);
    await this.runPromise?.catch(() => undefined);
    this.runPromise = undefined;
    this.helper = undefined;
    this.client = undefined;
    this.availability = undefined;
    this.platformValue = undefined;
  }

  /** Fence this generation's admission, retaining accepted helper/result owners. */
  pauseNewClaims(): void {
    this.pauseRevision += 1;
    this.claimsPaused = true;
    this.claimAbortController?.abort();
    if (!this.acceptedCommand) this.stopHeartbeat();
  }

  /** Rebind the desktop driver lease after the daemon authority is recreated. */
  async restart(): Promise<void> {
    if (!this.runPromise && !this.abortController && !this.claimsPaused) return;
    const revision = this.pauseRevision;
    await this.stop();
    if (revision !== this.pauseRevision) return;
    this.claimsPaused = false;
    await this.start();
  }

  private async runClaimLoop(signal: AbortSignal, claimSignal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.claimsPaused) {
      let accepted = false;
      try {
        const command = await this.client?.claim(claimSignal);
        if (!command || signal.aborted) continue;
        if (this.claimsPaused || claimSignal.aborted) {
          this.claimedNotStarted(command.id);
          return;
        }
        accepted = true;
        this.acceptedCommand = true;
        const result = await this.execute(command);
        await this.client?.complete(result, signal);
      } catch (error) {
        if (signal.aborted || (this.claimsPaused && !accepted)) return;
        const code = safeErrorCode(error);
        this.options.onDiagnostic?.("office_driver.claim_failed", { error: code });
        if (!this.claimsPaused && code === "office_driver_authority_invalid" && this.platformValue) {
          await this.refreshAvailability(this.platformValue, claimSignal).catch((recoveryError) => {
            if (!claimSignal.aborted) this.options.onDiagnostic?.("office_driver.availability_failed", { error: safeErrorCode(recoveryError) });
          });
        }
        if (!this.claimsPaused) await delay(ERROR_BACKOFF_MS, claimSignal);
      } finally {
        if (accepted) {
          this.acceptedCommand = false;
          if (this.claimsPaused) this.stopHeartbeat();
        }
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private claimedNotStarted(commandId: string): void {
    try {
      this.options.onDiagnostic?.("office_driver.claimed_not_started", {
        commandId, effectState: "not_started", hostState: "unknown",
      });
    } catch { /* No fabricated completion or change of Host authority. */ }
  }

  private async execute(command: OfficeDriverRequest): Promise<OfficeDriverResult> {
    try {
      const helperCommand = toHelperCommand(command, this.generation);
      const result = await this.helper?.call(helperCommand);
      if (!result) throw new Error("office_driver_not_running");
      return normalizeHelperResult(command, result, this.generation);
    } catch (error) {
      const errorCode = safeErrorCode(error);
      if (shouldRecoverHelper(errorCode)) {
        await this.recoverHelper().catch((recoveryError) => {
          this.options.onDiagnostic?.("office_driver.recovery_failed", { error: safeErrorCode(recoveryError) });
        });
      }
      return {
        protocol: OFFICE_DRIVER_PROTOCOL,
        id: command.id,
        ok: false,
        error: { code: errorCode, message: "The local Office driver could not complete the request." },
      };
    }
  }

  private async recoverHelper(): Promise<void> {
    if (this.helperRecoveryPromise) return await this.helperRecoveryPromise;
    const helper = this.helper;
    const platform = this.platformValue;
    const signal = this.abortController?.signal;
    if (!helper || !platform || signal?.aborted || this.claimsPaused) return;
    const recovery = (async () => {
      await helper.stop().catch(() => undefined);
      if (signal?.aborted || this.claimsPaused) return;
      await helper.start();
      if (signal?.aborted) {
        await helper.stop().catch(() => undefined);
        return;
      }
      if (this.claimsPaused) return;
      await this.refreshAvailability(platform, this.claimAbortController?.signal ?? signal);
      this.options.onDiagnostic?.("office_driver.recovered");
    })();
    this.helperRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (this.helperRecoveryPromise === recovery) this.helperRecoveryPromise = undefined;
    }
  }

  private async refreshAvailability(platform: OfficeDriverPlatform, signal?: AbortSignal): Promise<void> {
    const helper = this.helper;
    const client = this.client;
    if (!helper || !client || signal?.aborted || this.claimsPaused) return;
    const id = randomUUID();
    const result = await helper.call({
      protocol: OFFICE_DRIVER_PROTOCOL,
      id,
      method: "driver_status",
      params: {},
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      idempotencyKey: `driver-status:${this.generation}:${Math.floor(Date.now() / AVAILABILITY_HEARTBEAT_MS)}`,
    });
    // driver_status may have been in flight when admission closed. It is not
    // permission to publish a fresh idle lease or recover/restart the helper.
    if (signal?.aborted || this.claimsPaused) return;
    if (!result.ok) throw new Error(result.error?.code ?? "office_driver_status_failed");
    const status = readHelperStatus(result.result);
    const availability = parseOfficeDriverAvailability({
      protocol: OFFICE_DRIVER_PROTOCOL,
      generation: this.generation,
      desktopInstanceId: this.options.desktopInstanceId,
      platform,
      ...status,
      checkedAt: new Date().toISOString(),
    });
    this.availability = availability;
    try {
      await client.publishAvailability(availability, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("office_driver_daemon_unavailable");
    }
  }

  private async renewAcceptedAvailability(signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.acceptedCommand || !this.availability) return;
    await this.client?.publishAvailability({ ...this.availability, checkedAt: new Date().toISOString() }, signal);
  }

  private async publishSyntheticFailure(platform: OfficeDriverPlatform, errorCode: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.claimsPaused) return;
    const availability = parseOfficeDriverAvailability({
      protocol: OFFICE_DRIVER_PROTOCOL,
      generation: this.generation,
      desktopInstanceId: this.options.desktopInstanceId,
      platform,
      helperVersion: "unavailable",
      state: "driver_error",
      capabilities: [],
      officeInstalled: false,
      applicationRunning: false,
      permissionGranted: false,
      errorCode,
      checkedAt: new Date().toISOString(),
    });
    this.availability = availability;
    await this.client?.publishAvailability(availability, signal).catch(() => undefined);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function resolveOfficeDriverExecutablePath(input: {
  readonly appPath: string;
  readonly resourcesRoot: string;
  readonly packaged: boolean;
  readonly platform?: string;
  readonly architecture?: string;
}): string | undefined {
  const platform = readPlatform(input.platform ?? process.platform);
  const architecture = input.architecture ?? process.arch;
  if (!platform || (platform === "darwin" && architecture !== "arm64") || (platform === "win32" && architecture !== "x64")) {
    return undefined;
  }
  const relativePath = platform === "darwin"
    ? "darwin-arm64/OfficeDriver.app/Contents/MacOS/ling-office-driver"
    : "win32-x64/ling-office-driver.exe";
  return input.packaged
    ? resolve(input.resourcesRoot, "office-driver", relativePath)
    : resolve(input.appPath, "dist", "office-driver", relativePath);
}

function readPlatform(value: string): OfficeDriverPlatform | undefined {
  return value === "darwin" || value === "win32" ? value : undefined;
}

function readHelperStatus(value: unknown): HelperStatus {
  if (!isRecord(value)) throw new Error("office_driver_status_invalid");
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  return {
    helperVersion: readString(value.helperVersion, 64),
    state: readRuntimeState(value.state),
    capabilities: capabilities.filter((item): item is OfficeDriverCapability => typeof item === "string"),
    officeInstalled: value.officeInstalled === true,
    applicationRunning: value.applicationRunning === true,
    ...(typeof value.permissionGranted === "boolean" ? { permissionGranted: value.permissionGranted } : {}),
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode.slice(0, 96) } : {}),
  };
}

function readRuntimeState(value: unknown): OfficeDriverRuntimeState {
  if (value === "ready" || value === "office_missing" || value === "permission_required"
    || value === "application_not_running" || value === "limited" || value === "driver_error") return value;
  throw new Error("office_driver_status_invalid");
}

function readString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error("office_driver_status_invalid");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toHelperCommand(command: OfficeDriverRequest, generation: number): OfficeDriverRequest {
  if (command.method === "driver_status" || command.method === "list_sessions") return command;
  if (!isRecord(command.params)) throw new Error("office_driver_session_required");
  const sessionId = command.params.sessionId;
  if (typeof sessionId !== "string") throw new Error("office_driver_session_required");
  const rawSessionId = decodePublicSessionId(sessionId, generation);
  return { ...command, params: { ...command.params, sessionId: rawSessionId } };
}

export function normalizeHelperResult(
  command: OfficeDriverRequest,
  result: OfficeDriverResult,
  generation: number,
): OfficeDriverResult {
  if (!result.ok) return result;
  if (command.method === "driver_status") return result;
  if (command.method === "list_sessions") {
    if (!Array.isArray(result.result) || result.result.length > 100) throw new Error("office_driver_sessions_invalid");
    return {
      ...result,
      result: result.result.map((value) => publicSessionProjection(value, generation)),
    };
  }
  if (!isRecord(command.params) || typeof command.params.sessionId !== "string") {
    throw new Error("office_driver_session_required");
  }
  if (!isRecord(result.result) || typeof result.result.sessionId !== "string") {
    throw new Error("office_driver_result_invalid");
  }
  const expectedRawId = decodePublicSessionId(command.params.sessionId, generation);
  if (result.result.sessionId !== expectedRawId) throw new Error("office_driver_session_mismatch");
  return {
    ...result,
    result: { ...result.result, sessionId: command.params.sessionId },
  };
}

function publicSessionProjection(value: unknown, generation: number): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("office_driver_sessions_invalid");
  const rawId = boundedString(value.id, 220, "office_driver_sessions_invalid");
  const platform = value.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error("office_driver_sessions_invalid");
  if (value.application !== "excel" || typeof value.readOnly !== "boolean" || typeof value.dirty !== "boolean") {
    throw new Error("office_driver_sessions_invalid");
  }
  const capabilities = parseSessionCapabilities(value.capabilities, platform);
  const workbookPath = value.workbookPath === undefined || value.workbookPath === ""
    ? undefined
    : boundedString(value.workbookPath, 4096, "office_driver_sessions_invalid");
  return {
    id: encodePublicSessionId(rawId, generation),
    generation,
    platform,
    application: "excel",
    workbookName: boundedString(value.workbookName, 512, "office_driver_sessions_invalid"),
    ...(workbookPath ? { workbookPath } : {}),
    ...(value.activeSheet === undefined || value.activeSheet === ""
      ? {}
      : { activeSheet: boundedString(value.activeSheet, 128, "office_driver_sessions_invalid") }),
    readOnly: value.readOnly,
    dirty: value.dirty,
    capabilities,
  };
}

function parseSessionCapabilities(value: unknown, platform: OfficeDriverPlatform): readonly OfficeDriverCapability[] {
  if (!Array.isArray(value) || value.length > officeDriverCapabilities.length) {
    throw new Error("office_driver_sessions_invalid");
  }
  const allowed = new Set<string>(officeDriverCapabilities);
  const unique = new Set<OfficeDriverCapability>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item) || unique.has(item as OfficeDriverCapability)) {
      throw new Error("office_driver_sessions_invalid");
    }
    if (platform === "darwin" && ["excel:tables", "excel:charts", "excel:filters", "excel:resize"].includes(item)) {
      throw new Error("office_driver_sessions_invalid");
    }
    unique.add(item as OfficeDriverCapability);
  }
  return [...unique];
}

function encodePublicSessionId(rawSessionId: string, generation: number): string {
  const value = `${generation}:${rawSessionId}`;
  if (value.length > 256) throw new Error("office_driver_sessions_invalid");
  return value;
}

function decodePublicSessionId(value: string, generation: number): string {
  const prefix = `${generation}:`;
  if (!value.startsWith(prefix) || value.length <= prefix.length) throw new Error("office_driver_session_stale");
  return value.slice(prefix.length);
}

function boundedString(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(code);
  return value;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,96}$/iu.test(message) ? message : "office_driver_failed";
}

function shouldRecoverHelper(errorCode: string): boolean {
  return errorCode !== "office_driver_session_required"
    && errorCode !== "office_driver_session_stale"
    && errorCode !== "office_driver_daemon_unavailable";
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(settle, ms);
    function settle() {
      clearTimeout(timer);
      signal.removeEventListener("abort", settle);
      resolveDelay();
    }
    signal.addEventListener("abort", settle, { once: true });
  });
}
