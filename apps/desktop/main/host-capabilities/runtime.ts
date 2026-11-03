import { randomUUID } from "node:crypto";
import {
  HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
  type HostCapabilityBridgeAvailabilityV1,
  type HostCapabilityBridgeCommandV1,
  type HostCapabilityBridgeResultV1,
  type HostOpenLocalTargetReceiptV1,
} from "@ling-stack/contracts";
import {
  HostCapabilityDaemonClient,
  HostCapabilityDaemonClientError,
  type HostCapabilityDaemonTransport,
} from "./daemon-client.js";
import {
  HostLocalPreviewManager,
  type HostPreviewLaunch,
} from "./preview-manager.js";

const AVAILABILITY_HEARTBEAT_MS = 4_000;
const ERROR_BACKOFF_MS = 500;
const RESULT_ACK_ATTEMPTS = 3;

export class HostCapabilityRuntime {
  private abortController: AbortController | undefined;
  private claimAbortController: AbortController | undefined;
  private claimsPaused = false;
  private pauseRevision = 0;
  private acceptedCommand = false;
  private runPromise: Promise<void> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private client: HostCapabilityDaemonTransport | undefined;
  private previewManagerValue: HostLocalPreviewManager | undefined;
  private generation = 0;

  constructor(private readonly options: {
    readonly daemonBaseUrl: string;
    readonly bridgeToken: string;
    readonly desktopInstanceId: string;
    readonly previewManager?: HostLocalPreviewManager;
    readonly daemonClientFactory?: (generation: number) => HostCapabilityDaemonTransport;
    readonly now?: () => number;
    readonly heartbeatMs?: number;
    readonly errorBackoffMs?: number;
    readonly onDiagnostic?: (event: string, details?: Readonly<Record<string, unknown>>) => void;
  }) {}

  async start(): Promise<void> {
    if (this.runPromise || this.abortController || this.claimsPaused) return;
    this.generation = Math.max(this.generation + 1, this.now());
    this.abortController = new AbortController();
    this.claimAbortController = new AbortController();
    this.client = this.options.daemonClientFactory?.(this.generation) ?? new HostCapabilityDaemonClient({
      daemonBaseUrl: this.options.daemonBaseUrl,
      bridgeToken: this.options.bridgeToken,
      desktopInstanceId: this.options.desktopInstanceId,
      generation: this.generation,
    });
    const signal = this.abortController.signal;
    const claimSignal = this.claimAbortController.signal;
    await this.publishAvailability(claimSignal).catch((error) => {
      if (!claimSignal.aborted) this.diagnostic("host_capability.availability_failed", error);
    });
    if (signal.aborted || this.claimsPaused) return;
    this.runPromise = this.runClaimLoop(signal, claimSignal);
    this.heartbeat = setInterval(() => {
      if (signal.aborted || (this.claimsPaused && !this.acceptedCommand)) return;
      // Availability is also the authority lease for an accepted result. Do
      // not cancel that lease merely because no new commands may be claimed.
      const availabilitySignal = this.acceptedCommand ? signal : claimSignal;
      void this.publishAvailability(availabilitySignal).catch((error) => {
        if (!availabilitySignal.aborted) this.diagnostic("host_capability.heartbeat_failed", error);
      });
    }, this.options.heartbeatMs ?? AVAILABILITY_HEARTBEAT_MS);
  }

  async stop(): Promise<void> {
    await this.stopInternal(true);
  }

  /** Fence this generation's admission without aborting an accepted effect/result. */
  pauseNewClaims(): void {
    this.pauseRevision += 1;
    this.claimsPaused = true;
    this.claimAbortController?.abort();
    if (!this.acceptedCommand) this.stopHeartbeat();
  }

  /**
   * Rebind the host bridge after the daemon authority is recreated. The
   * desktop-owned preview manager remains reusable across a daemon restart;
   * closing it here would permanently disable subsequent previews.
   */
  async restart(): Promise<void> {
    if (!this.runPromise && !this.abortController && !this.claimsPaused) return;
    const revision = this.pauseRevision;
    await this.stopInternal(false);
    // Only an explicit new-generation rebind may reopen admission. A newer
    // drain observed while the old generation was stopping still wins.
    if (revision !== this.pauseRevision) return;
    this.claimsPaused = false;
    await this.start();
  }

  private async stopInternal(closePreviewManager: boolean): Promise<void> {
    this.stopHeartbeat();
    this.claimAbortController?.abort();
    this.claimAbortController = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
    await this.runPromise?.catch(() => undefined);
    this.runPromise = undefined;
    this.client = undefined;
    if (closePreviewManager) {
      await (this.previewManagerValue ?? this.options.previewManager)?.close();
    }
  }

  private async runClaimLoop(signal: AbortSignal, claimSignal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.claimsPaused) {
      try {
        const command = await this.client?.claim(claimSignal);
        if (!command || signal.aborted) continue;
        if (this.claimsPaused || claimSignal.aborted) {
          this.claimedNotStarted(command.id);
          return;
        }
        this.acceptedCommand = true;
        try { await this.execute(command, signal); }
        finally {
          this.acceptedCommand = false;
          if (this.claimsPaused) this.stopHeartbeat();
        }
      } catch (error) {
        if (signal.aborted || this.claimsPaused) return;
        this.diagnostic("host_capability.claim_failed", error);
        if (error instanceof HostCapabilityDaemonClientError
          && error.daemonCode === "host_capability_authority_invalid") {
          await this.publishAvailability(claimSignal).catch((recoveryError) => {
            if (!claimSignal.aborted) this.diagnostic("host_capability.availability_failed", recoveryError);
          });
        }
        await delay(this.options.errorBackoffMs ?? ERROR_BACKOFF_MS, claimSignal);
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private claimedNotStarted(commandId: string): void {
    // At most one claim is outstanding. A lost/late claim is not an effect or
    // a Host stop receipt; no begin/result/requeue is manufactured here.
    try {
      this.options.onDiagnostic?.("host_capability.claimed_not_started", {
        commandId, effectState: "not_started", hostState: "unknown",
      });
    } catch { /* Observation cannot reopen admission or retire the owner. */ }
  }

  private async execute(command: HostCapabilityBridgeCommandV1, signal: AbortSignal): Promise<void> {
    const client = this.client;
    if (!client) return;
    let begun = false;
    let launch: HostPreviewLaunch | undefined;
    try {
      if (Date.parse(command.deadlineAt) <= this.now()) throw new Error("host_capability_timeout");
      await client.begin(command.id, signal);
      begun = true;
      signal.throwIfAborted();
      launch = await this.previewManager.launch(command);
      const result = success(command, this.now());
      await this.completeWithRetry(client, result, signal);
      this.options.onDiagnostic?.("host_capability.completed", {
        capabilityId: command.capabilityId,
        presentation: command.presentation,
      });
    } catch (error) {
      launch?.close();
      if (signal.aborted) return;
      const code = safeErrorCode(error);
      this.diagnostic("host_capability.execution_failed", error);
      if (begun) {
        await this.completeWithRetry(client, failure(command.id, code), signal).catch((completionError) => {
          if (!signal.aborted) this.diagnostic("host_capability.failure_receipt_failed", completionError);
        });
      }
    }
  }

  private async completeWithRetry(
    client: HostCapabilityDaemonTransport,
    result: HostCapabilityBridgeResultV1,
    signal: AbortSignal,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RESULT_ACK_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      try {
        await client.complete(result, signal);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < RESULT_ACK_ATTEMPTS) {
          await delay(this.options.errorBackoffMs ?? ERROR_BACKOFF_MS, signal);
        }
      }
    }
    throw lastError;
  }

  private async publishAvailability(signal: AbortSignal): Promise<void> {
    const value: HostCapabilityBridgeAvailabilityV1 = {
      protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
      desktopInstanceId: this.options.desktopInstanceId,
      generation: this.generation,
      capabilities: ["host.open_local_target"],
      checkedAt: new Date(this.now()).toISOString(),
    };
    await this.client?.publishAvailability(value, signal);
  }

  private get previewManager(): HostLocalPreviewManager {
    this.previewManagerValue ??= this.options.previewManager ?? new HostLocalPreviewManager({
      desktopInstanceId: this.options.desktopInstanceId,
    });
    return this.previewManagerValue;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private diagnostic(event: string, error: unknown): void {
    this.options.onDiagnostic?.(event, { error: safeErrorCode(error) });
  }
}

function success(command: HostCapabilityBridgeCommandV1, now: number): HostCapabilityBridgeResultV1 {
  const receipt: HostOpenLocalTargetReceiptV1 = {
    contractVersion: 1,
    capabilityId: "host.open_local_target",
    status: "launched",
    path: command.path,
    runId: command.runId,
    attemptId: command.attemptId,
    toolCallId: command.toolCallId,
    approvalId: command.approvalId,
    receiptId: randomUUID(),
    launchedAt: new Date(now).toISOString(),
    visibility: "unverified",
  };
  return { protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1, id: command.id, ok: true, receipt };
}

function failure(commandId: string, code: string): HostCapabilityBridgeResultV1 {
  return {
    protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
    id: commandId,
    ok: false,
    error: { code, message: "The isolated Ling preview could not display this workspace file." },
  };
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,96}$/iu.test(value) ? value : "host_preview_failed";
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
