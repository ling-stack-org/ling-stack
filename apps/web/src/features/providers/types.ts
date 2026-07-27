import type { ProviderModelImportResponse } from "../../types.js";

export interface ProviderBatchResult {
  readonly message: string;
  readonly failedCount: number;
}

export interface ProviderSaveResult {
  readonly ok: boolean;
  readonly errorMessage?: string;
  readonly warningMessage?: string;
  readonly successMessage?: string;
}

export interface ProviderImportResult {
  readonly ok: boolean;
  readonly response?: ProviderModelImportResponse;
  readonly errorMessage?: string;
  readonly successMessage?: string;
}

export type ProviderCheckScope = "row" | "batch" | "save";
