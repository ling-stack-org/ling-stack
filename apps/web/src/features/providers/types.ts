export interface ProviderBatchResult {
  readonly message: string;
  readonly failedCount: number;
}

export type ProviderCheckScope = "row" | "batch" | "save";
