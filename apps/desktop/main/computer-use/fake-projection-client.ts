import type {
  ComputerUsePreviewEvent,
  ComputerUsePreviewProjection,
  StopComputerUseResponse,
} from "@ling-stack/contracts";
import type {
  ComputerUseProjectionConnectionState,
  ComputerUseProjectionClient,
  ComputerUseProjectionSubscription,
} from "./projection-client.js";

export class FakeComputerUseProjectionClient implements ComputerUseProjectionClient {
  private readonly listeners = new Set<(event: ComputerUsePreviewEvent) => void>();
  private readonly connectionListeners = new Set<(state: ComputerUseProjectionConnectionState) => void>();
  private seq = 0;
  private stopRequestCount = 0;

  constructor(private projection: ComputerUsePreviewProjection) {}

  async list(): Promise<readonly ComputerUsePreviewProjection[]> {
    return [this.projection];
  }

  subscribe(
    listener: (event: ComputerUsePreviewEvent) => void,
    onConnectionStateChanged?: (state: ComputerUseProjectionConnectionState) => void,
  ): ComputerUseProjectionSubscription {
    this.listeners.add(listener);
    if (onConnectionStateChanged) {
      this.connectionListeners.add(onConnectionStateChanged);
    }
    return {
      close: () => {
        this.listeners.delete(listener);
        if (onConnectionStateChanged) {
          this.connectionListeners.delete(onConnectionStateChanged);
        }
      },
    };
  }

  async stop(sessionId: string): Promise<StopComputerUseResponse> {
    this.stopRequestCount += 1;
    const acknowledgedAt = new Date().toISOString();
    this.emit({ ...this.projection, status: "stopping", updatedAt: acknowledgedAt });
    this.emit({ ...this.projection, status: "cancelled", updatedAt: acknowledgedAt, terminalAt: acknowledgedAt });
    return {
      sessionId,
      accepted: true,
      acknowledged: true,
      auditId: "fake-computer-use-stop-audit",
      projection: this.projection,
      acknowledgedAt,
    };
  }

  getStopRequestCount(): number {
    return this.stopRequestCount;
  }

  emitConnectionState(state: ComputerUseProjectionConnectionState): void {
    for (const listener of this.connectionListeners) {
      listener(state);
    }
  }

  emit(projection: ComputerUsePreviewProjection): void {
    this.projection = projection;
    this.seq += 1;
    const event: ComputerUsePreviewEvent = {
      seq: this.seq,
      kind: "upsert",
      sessionId: projection.sessionId,
      projection,
      occurredAt: projection.updatedAt,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const FAKE_COMPUTER_USE_PROJECTION: ComputerUsePreviewProjection = {
  sessionId: "preview_fake_session_01",
  conversationId: "preview_fake_conversation_01",
  runId: "preview_fake_run_01",
  workUnitId: "preview_fake_work_unit_01",
  status: "running",
  target: {
    kind: "browser",
    displayName: "Browser task",
    applicationId: "com.example.browser",
  },
  preview: {
    descriptorId: "preview_fake_session_01",
    revision: 1,
    aspectRatio: 1.6,
    cursorAvailable: true,
  },
  startedAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:01.000Z",
};
