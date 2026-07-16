import { LingDaemonClient } from "@ling-stack/api-client";
import type {
  ComputerUsePreviewEvent,
  ComputerUsePreviewProjection,
} from "@ling-stack/contracts";
import { COMPUTER_USE_ROUTE_TOKEN_HEADER } from "@ling-stack/contracts";
import type {
  ComputerUseProjectionClient,
  ComputerUseProjectionSubscription,
} from "./projection-client.js";

export class DaemonComputerUseProjectionClient implements ComputerUseProjectionClient {
  private readonly client: LingDaemonClient;
  private readonly knownProjections = new Map<string, ComputerUsePreviewProjection>();

  constructor(
    private readonly cwd: string,
    baseUrl: string,
    private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = waitForDelay,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    computerUseRouteToken?: string,
  ) {
    this.client = new LingDaemonClient({
      baseUrl,
      fetch: fetchImpl,
      computerUseRouteToken,
    });
  }

  async list(): Promise<readonly ComputerUsePreviewProjection[]> {
    const snapshot = await this.fetchSnapshot();
    this.rememberSnapshot(snapshot.projections);
    return snapshot.projections;
  }

  subscribe(listener: (event: ComputerUsePreviewEvent) => void): ComputerUseProjectionSubscription {
    const controller = new AbortController();
    void this.consume(listener, controller.signal);
    return { close: () => controller.abort() };
  }

  stop(sessionId: string, reason?: string) {
    return this.client.stopComputerUse(this.cwd, sessionId, reason ? { reason } : {});
  }

  private async consume(listener: (event: ComputerUsePreviewEvent) => void, signal: AbortSignal): Promise<void> {
    let afterSeq = 0;
    let attempt = 0;
    let lastSnapshotSeq: number | undefined;
    let streamEpoch = 0;
    let forceSnapshotReset = false;
    while (!signal.aborted) {
      try {
        const snapshot = await this.refreshSnapshot(
          listener,
          signal,
          forceSnapshotReset,
          lastSnapshotSeq,
        );
        forceSnapshotReset = false;
        if (signal.aborted) {
          return;
        }
        if (snapshot.epochReset) {
          streamEpoch += 1;
        }
        lastSnapshotSeq = snapshot.latestSeq;
        afterSeq = snapshot.latestSeq;

        const connectionEpoch = streamEpoch;
        const response = await this.client.streamComputerUsePreviews(this.cwd, afterSeq, signal);
        if (!response.body) {
          throw new Error("computer_use_stream_body_missing");
        }
        for await (const message of readSseMessages(response.body, signal)) {
          if (connectionEpoch !== streamEpoch) {
            throw new Error("computer_use_stream_epoch_changed");
          }
          if (message.event === "heartbeat") {
            const latestSeq = readHeartbeatLatestSeq(message.data);
            if (latestSeq !== undefined && latestSeq < afterSeq) {
              streamEpoch += 1;
              forceSnapshotReset = true;
              throw new Error("computer_use_stream_epoch_reset");
            }
            continue;
          }
          if (message.event !== "computer_use_event") {
            continue;
          }
          const event = parseComputerUsePreviewEvent(message.data);
          if (!event) {
            continue;
          }
          if (event.seq <= afterSeq) {
            continue;
          }
          if (event.seq > afterSeq + 1) {
            streamEpoch += 1;
            forceSnapshotReset = true;
            throw new Error("computer_use_stream_gap");
          }
          afterSeq = event.seq;
          this.rememberEvent(event);
          listener(event);
        }
        if (!signal.aborted) {
          throw new Error("computer_use_stream_closed");
        }
        attempt = 0;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        attempt += 1;
        await this.wait(Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5)), signal).catch(() => undefined);
      }
    }
  }

  private async refreshSnapshot(
    listener: (event: ComputerUsePreviewEvent) => void,
    signal: AbortSignal,
    forceReset = false,
    previousLatestSeq?: number,
  ): Promise<{
    readonly projections: readonly ComputerUsePreviewProjection[];
    readonly latestSeq: number;
    readonly epochReset: boolean;
  }> {
    const snapshot = await this.fetchSnapshot(signal);
    if (signal.aborted) {
      throw signal.reason ?? new Error("computer_use_subscription_closed");
    }
    const projections = snapshot.projections;
    const latestSeq = snapshot.latestSeq;
    const epochReset = previousLatestSeq !== undefined && latestSeq < previousLatestSeq;
    const shouldReset = forceReset || epochReset;
    const current = new Map(projections.map((projection) => [projection.sessionId, projection]));
    const snapshotEventSeq = latestSeq;
    const occurredAt = new Date().toISOString();

    for (const sessionId of this.knownProjections.keys()) {
      if (shouldReset || !current.has(sessionId)) {
        const event: ComputerUsePreviewEvent = {
          seq: snapshotEventSeq,
          kind: "remove",
          sessionId,
          occurredAt,
        };
        this.knownProjections.delete(sessionId);
        listener(event);
      }
    }
    for (const projection of projections) {
      const previous = this.knownProjections.get(projection.sessionId);
      if (shouldReset || !previous || JSON.stringify(previous) !== JSON.stringify(projection)) {
        const event: ComputerUsePreviewEvent = {
          seq: snapshotEventSeq,
          kind: "upsert",
          sessionId: projection.sessionId,
          projection,
          occurredAt: projection.updatedAt,
        };
        this.knownProjections.set(projection.sessionId, projection);
        listener(event);
      }
    }
    return { projections, latestSeq, epochReset };
  }

  private async fetchSnapshot(signal?: AbortSignal): Promise<ComputerUseProjectionSnapshot> {
    const response = await this.client._fetch(
      this.client._url("/computer-use/snapshot", { cwd: this.cwd }),
      {
        method: "GET",
        headers: this.client.computerUseRouteToken
          ? { [COMPUTER_USE_ROUTE_TOKEN_HEADER]: this.client.computerUseRouteToken }
          : undefined,
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`computer_use_snapshot_http_${response.status}`);
    }
    const value = await response.json() as unknown;
    if (!isComputerUseProjectionSnapshot(value)) {
      throw new Error("computer_use_snapshot_invalid");
    }
    return value;
  }

  private rememberSnapshot(projections: readonly ComputerUsePreviewProjection[]): void {
    this.knownProjections.clear();
    for (const projection of projections) {
      this.knownProjections.set(projection.sessionId, projection);
    }
  }

  private rememberEvent(event: ComputerUsePreviewEvent): void {
    if (event.kind === "remove") {
      this.knownProjections.delete(event.sessionId);
    } else if (event.projection) {
      this.knownProjections.set(event.sessionId, event.projection);
    }
  }
}

async function* readSseMessages(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ readonly event: string; readonly data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) {
          yield parsed;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): { readonly event: string; readonly data: string } | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return data.length > 0 ? { event, data: data.join("\n") } : undefined;
}

function parseComputerUsePreviewEvent(value: string): ComputerUsePreviewEvent | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.seq !== "number" || typeof parsed.sessionId !== "string") {
      return undefined;
    }
    if (parsed.kind !== "upsert" && parsed.kind !== "remove") {
      return undefined;
    }
    if (typeof parsed.occurredAt !== "string") {
      return undefined;
    }
    return parsed as unknown as ComputerUsePreviewEvent;
  } catch {
    return undefined;
  }
}

function readHeartbeatLatestSeq(value: string): number | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && typeof parsed.latestSeq === "number" && Number.isFinite(parsed.latestSeq)
      ? parsed.latestSeq
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ComputerUseProjectionSnapshot {
  readonly cwd: string;
  readonly projections: readonly ComputerUsePreviewProjection[];
  readonly latestSeq: number;
}

function isComputerUseProjectionSnapshot(value: unknown): value is ComputerUseProjectionSnapshot {
  return isRecord(value)
    && typeof value.cwd === "string"
    && Array.isArray(value.projections)
    && typeof value.latestSeq === "number"
    && Number.isInteger(value.latestSeq)
    && value.latestSeq >= 0;
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}
