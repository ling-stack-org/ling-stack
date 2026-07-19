import type {
  CuaDriverReadinessContext,
  CuaDriverReadinessController,
  CuaDriverReadinessResult,
} from "../readiness-controller.js";

export const DEFAULT_DARWIN_PERMISSION_POLL_MS = 1_000;

export interface DarwinHostPermissionSnapshot {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export interface DarwinHostPermissionPort {
  read(): Promise<DarwinHostPermissionSnapshot>;
  /** Prove the host can currently enumerate and render at least one screen source. */
  probeLiveScreenCapture(): Promise<boolean>;
  /** Called only from an explicit user action. */
  requestAccessibility(): Promise<void>;
  /** Trigger a real host capture attempt; never reset TCC automatically. */
  requestScreenRecording(): Promise<void>;
}

export interface DarwinPermissionMonitorScheduler {
  schedule(task: () => Promise<void>, delayMs: number): { cancel(): void };
}

export class DarwinCuaDriverPermissionError extends Error {
  readonly code = "cua_driver_darwin_permission_failed" as const;

  constructor(readonly permissionCode: "disposed" | "unavailable") {
    super(`darwin_permission_${permissionCode}`);
    this.name = "DarwinCuaDriverPermissionError";
  }
}

export class DarwinCuaDriverPermissionController {
  private readonly scheduler: DarwinPermissionMonitorScheduler;
  private readonly pollIntervalMs: number;
  private monitoring = false;
  private disposed = false;
  private monitorEpoch = 0;
  private scheduled: { cancel(): void } | undefined;
  private baseline: DarwinHostPermissionSnapshot | undefined;
  private requestPromise: Promise<DarwinHostPermissionSnapshot> | undefined;

  constructor(private readonly options: {
    readonly port?: DarwinHostPermissionPort;
    readonly onChanged?: (
      current: DarwinHostPermissionSnapshot,
      previous: DarwinHostPermissionSnapshot,
    ) => void | Promise<void>;
    readonly scheduler?: DarwinPermissionMonitorScheduler;
    readonly pollIntervalMs?: number;
  } = {}) {
    this.scheduler = options.scheduler ?? createDefaultPermissionScheduler();
    this.pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
  }

  async snapshot(): Promise<DarwinHostPermissionSnapshot> {
    if (this.disposed) {
      throw new DarwinCuaDriverPermissionError("disposed");
    }
    try {
      return normalizePermissionSnapshot(await (this.options.port ?? defaultDarwinHostPermissionPort).read());
    } catch (error) {
      if (error instanceof DarwinCuaDriverPermissionError) {
        throw error;
      }
      throw new DarwinCuaDriverPermissionError("unavailable");
    }
  }

  async probeLiveScreenCapture(): Promise<boolean> {
    if (this.disposed) {
      throw new DarwinCuaDriverPermissionError("disposed");
    }
    try {
      const capturable = await (this.options.port ?? defaultDarwinHostPermissionPort)
        .probeLiveScreenCapture();
      if (typeof capturable !== "boolean") {
        throw new DarwinCuaDriverPermissionError("unavailable");
      }
      return capturable;
    } catch (error) {
      if (error instanceof DarwinCuaDriverPermissionError) {
        throw error;
      }
      throw new DarwinCuaDriverPermissionError("unavailable");
    }
  }

  /** Explicit user action: request both host-owned TCC grants exactly once. */
  requestHostPermissions(): Promise<DarwinHostPermissionSnapshot> {
    if (this.disposed) {
      return Promise.reject(new DarwinCuaDriverPermissionError("disposed"));
    }
    if (this.requestPromise) {
      return this.requestPromise;
    }
    const pending = this.requestHostPermissionsInternal();
    this.requestPromise = pending;
    void pending.finally(() => {
      if (this.requestPromise === pending) {
        this.requestPromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  /**
   * Platform-specific monitoring is explicitly owned by DesktopRuntime. It is
   * never hidden inside the one-shot shared readiness interface.
   */
  async startMonitoring(): Promise<void> {
    if (this.disposed) {
      throw new DarwinCuaDriverPermissionError("disposed");
    }
    if (this.monitoring) {
      return;
    }
    const epoch = this.monitorEpoch + 1;
    this.monitorEpoch = epoch;
    this.monitoring = true;
    try {
      this.baseline = await this.snapshot();
    } catch (error) {
      this.monitoring = false;
      throw error;
    }
    if (this.isMonitorCurrent(epoch)) {
      this.scheduleNext(epoch);
    }
  }

  stopMonitoring(): void {
    this.monitoring = false;
    this.monitorEpoch += 1;
    this.scheduled?.cancel();
    this.scheduled = undefined;
    this.baseline = undefined;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopMonitoring();
  }

  private async requestHostPermissionsInternal(): Promise<DarwinHostPermissionSnapshot> {
    const port = this.options.port ?? defaultDarwinHostPermissionPort;
    try {
      await port.requestAccessibility();
      await port.requestScreenRecording();
      return await this.snapshot();
    } catch (error) {
      if (error instanceof DarwinCuaDriverPermissionError) {
        throw error;
      }
      throw new DarwinCuaDriverPermissionError("unavailable");
    }
  }

  private scheduleNext(epoch: number): void {
    this.scheduled?.cancel();
    this.scheduled = this.scheduler.schedule(async () => {
      this.scheduled = undefined;
      await this.poll(epoch);
    }, this.pollIntervalMs);
  }

  private async poll(epoch: number): Promise<void> {
    if (!this.isMonitorCurrent(epoch)) {
      return;
    }
    let current: DarwinHostPermissionSnapshot;
    try {
      current = await this.snapshot();
    } catch {
      if (this.isMonitorCurrent(epoch)) {
        this.scheduleNext(epoch);
      }
      return;
    }
    if (!this.isMonitorCurrent(epoch)) {
      return;
    }
    const previous = this.baseline ?? current;
    this.baseline = current;
    if (!samePermissionSnapshot(current, previous)) {
      try {
        await this.options.onChanged?.(current, previous);
      } catch {
        // Runtime recovery ownership is external; monitoring must remain live.
      }
    }
    if (this.isMonitorCurrent(epoch)) {
      this.scheduleNext(epoch);
    }
  }

  private isMonitorCurrent(epoch: number): boolean {
    return !this.disposed && this.monitoring && this.monitorEpoch === epoch;
  }
}

export class DarwinCuaDriverReadinessController implements CuaDriverReadinessController {
  constructor(private readonly permissions: DarwinCuaDriverPermissionController) {}

  async check(context: CuaDriverReadinessContext): Promise<CuaDriverReadinessResult> {
    if (context.platform !== "darwin" || !context.requestCheckPermissions) {
      return notReady(context, "platform_unavailable", "darwin_check_permissions_unavailable");
    }
    let host: DarwinHostPermissionSnapshot;
    try {
      host = await this.permissions.snapshot();
    } catch {
      return notReady(context, "platform_unavailable", "darwin_host_permission_probe_unavailable");
    }
    let response;
    try {
      response = await context.requestCheckPermissions();
    } catch {
      return notReady(context, "platform_unavailable", "darwin_check_permissions_request_failed");
    }
    const parsed = parseCheckPermissionsResponse(response);
    if (!parsed) {
      return notReady(context, "platform_unavailable", "darwin_check_permissions_response_invalid");
    }
    if (parsed.source.attribution !== "host"
      || parsed.source.embedded !== true
      || parsed.source.host_bundle_id !== "com.lingstack.desktop") {
      return notReady(context, "platform_unavailable", "darwin_host_attribution_invalid");
    }
    if (!host.accessibility || !parsed.accessibility) {
      return notReady(context, "permission_required", "darwin_accessibility_permission_required");
    }
    if (!host.screenRecording || !parsed.screen_recording) {
      return notReady(context, "permission_required", "darwin_screen_recording_permission_required");
    }
    let hostScreenCapturable: boolean;
    try {
      hostScreenCapturable = await this.permissions.probeLiveScreenCapture();
    } catch {
      return notReady(context, "platform_unavailable", "darwin_live_screen_capture_probe_unavailable");
    }
    if (!hostScreenCapturable) {
      return notReady(context, "permission_required", "darwin_host_screen_recording_not_capturable");
    }
    if (!parsed.screen_recording_capturable) {
      return notReady(context, "permission_required", "darwin_screen_recording_not_capturable");
    }
    return {
      generation: context.generation,
      childInstanceNonce: context.childInstanceNonce,
      ready: true,
      providerState: "ready",
    };
  }

  invalidate(_generation: number, _reason: string): void {
    // Monitoring is owned explicitly by DesktopRuntime and survives one child.
  }
}

function parseCheckPermissionsResponse(value: unknown): {
  readonly accessibility: boolean;
  readonly screen_recording: boolean;
  readonly screen_recording_capturable: boolean;
  readonly source: {
    readonly attribution: string;
    readonly embedded: boolean;
    readonly host_bundle_id: string;
  };
} | undefined {
  if (!isRecord(value) || !("result" in value) || !isRecord(value.result)) {
    return undefined;
  }
  const result = value.result;
  if (("isError" in result && typeof result.isError !== "boolean")
    || result.isError === true
    || !isRecord(result.structuredContent)) {
    return undefined;
  }
  const structured = result.structuredContent;
  const source = structured.source;
  if (typeof structured.accessibility !== "boolean"
    || typeof structured.screen_recording !== "boolean"
    || typeof structured.screen_recording_capturable !== "boolean"
    || !isRecord(source)
    || typeof source.attribution !== "string"
    || typeof source.embedded !== "boolean"
    || typeof source.host_bundle_id !== "string") {
    return undefined;
  }
  return {
    accessibility: structured.accessibility,
    screen_recording: structured.screen_recording,
    screen_recording_capturable: structured.screen_recording_capturable,
    source: {
      attribution: source.attribution,
      embedded: source.embedded,
      host_bundle_id: source.host_bundle_id,
    },
  };
}

function notReady(
  context: CuaDriverReadinessContext,
  providerState: "permission_required" | "platform_unavailable",
  reason: string,
): CuaDriverReadinessResult {
  return {
    generation: context.generation,
    childInstanceNonce: context.childInstanceNonce,
    ready: false,
    providerState,
    reason,
  };
}

function normalizePermissionSnapshot(value: DarwinHostPermissionSnapshot): DarwinHostPermissionSnapshot {
  if (!value || typeof value.accessibility !== "boolean" || typeof value.screenRecording !== "boolean") {
    throw new DarwinCuaDriverPermissionError("unavailable");
  }
  return Object.freeze({
    accessibility: value.accessibility,
    screenRecording: value.screenRecording,
  });
}

function samePermissionSnapshot(left: DarwinHostPermissionSnapshot, right: DarwinHostPermissionSnapshot): boolean {
  return left.accessibility === right.accessibility
    && left.screenRecording === right.screenRecording;
}

function boundedPollInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_DARWIN_PERMISSION_POLL_MS;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000) {
    throw new Error("darwin_permission_poll_interval_invalid");
  }
  return interval;
}

function createDefaultPermissionScheduler(): DarwinPermissionMonitorScheduler {
  return Object.freeze({
    schedule(task: () => Promise<void>, delayMs: number) {
      const timer = setTimeout(() => {
        void task();
      }, delayMs);
      timer.unref?.();
      return Object.freeze({ cancel: () => clearTimeout(timer) });
    },
  });
}

const defaultDarwinHostPermissionPort: DarwinHostPermissionPort = Object.freeze({
  async read() {
    const electron = await loadDarwinElectron();
    return {
      accessibility: electron.systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
    };
  },
  async probeLiveScreenCapture() {
    const electron = await loadDarwinElectron();
    const sources = await electron.desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    return sources.some((source) => !source.thumbnail.isEmpty());
  },
  async requestAccessibility() {
    const electron = await loadDarwinElectron();
    electron.systemPreferences.isTrustedAccessibilityClient(true);
  },
  async requestScreenRecording() {
    const electron = await loadDarwinElectron();
    await electron.desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
  },
});

async function loadDarwinElectron(): Promise<typeof import("electron")> {
  if (process.platform !== "darwin") {
    throw new DarwinCuaDriverPermissionError("unavailable");
  }
  const electron = await import("electron");
  if (!electron.systemPreferences || !electron.desktopCapturer) {
    throw new DarwinCuaDriverPermissionError("unavailable");
  }
  return electron;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
