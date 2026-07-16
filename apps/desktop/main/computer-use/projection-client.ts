import type {
  ComputerUsePreviewEvent,
  ComputerUsePreviewProjection,
  StopComputerUseResponse,
} from "@ling-stack/contracts";

export interface ComputerUseProjectionSubscription {
  close(): void;
}

export interface ComputerUseProjectionClient {
  list(): Promise<readonly ComputerUsePreviewProjection[]>;
  subscribe(listener: (event: ComputerUsePreviewEvent) => void): ComputerUseProjectionSubscription;
  stop(sessionId: string, reason?: string): Promise<StopComputerUseResponse>;
}
