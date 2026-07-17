import type {
  ComputerUsePreviewEvent,
  ComputerUsePreviewProjection,
  StopComputerUseResponse,
} from "@ling-stack/contracts";

export interface ComputerUseProjectionSubscription {
  close(): void;
}

export type ComputerUseProjectionConnectionState = "connected" | "disconnected";

export interface ComputerUseProjectionClient {
  list(): Promise<readonly ComputerUsePreviewProjection[]>;
  subscribe(
    listener: (event: ComputerUsePreviewEvent) => void,
    onConnectionStateChanged?: (state: ComputerUseProjectionConnectionState) => void,
  ): ComputerUseProjectionSubscription;
  stop(sessionId: string, reason?: string): Promise<StopComputerUseResponse>;
}
