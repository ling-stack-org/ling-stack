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
    if (this.runPromise) return;
    this.generation = Math.max(this.generation + 1, this.now());
    this.abortController = new AbortController();
    this.client = this.options.daemonClientFactory?.(this.generation) ?? new HostCapabilityDaemonClient({
      daemonBaseUrl: this.options.daemonBaseUrl,
      bridgeToken: this.options.bridgeToken,
      desktopInstanceId: this.options.desktopInstanceId,
      generation: this.generation,
    });
    const signal = this.abortController.signal;
    await this.publishAvailability(signal).catch((error) => {
      if (!signal.aborted) this.diagnostic("host_capability.availability_failed", error);
    });
    this.runPromise = this.runClaimLoop(signal);
    this.heartbeat = setInterval(() => {
      void this.publishAvailability(signal).catch((error) => {
        if (!signal.aborted) this.diagnostic("host_capability.heartbeat_failed", error);
      });
    }, this.options.heartbeatMs ?? AVAILABILITY_HEARTBEAT_MS);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
    await this.runPromise?.catch(() => undefined);
    this.runPromise = undefined;
    this.client = undefined;
    await this.previewManager.close();
  }

  private async runClaimLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const command = await this.client?.claim(signal);
        if (!command || signal.aborted) continue;
        await this.execute(command, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.diagnostic("host_capability.claim_failed", error);
        await delay(this.options.errorBackoffMs ?? ERROR_BACKOFF_MS, signal);
      }
    }
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
