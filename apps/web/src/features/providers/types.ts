import type { ProviderModelImportResponse } from "../../types.js";

export interface ProviderBatchResult {
  readonly message: string;
  readonly failedCount: number;
}

export interface ProviderSaveResult {
  readonly ok: boolean;
  readonly errorMessage?: string;
  readonly errorTechnicalMessage?: string;
  readonly warningMessage?: string;
  readonly successMessage?: string;
}

export interface ProviderImportResult {
  readonly ok: boolean;
  readonly response?: ProviderModelImportResponse;
  readonly errorMessage?: string;
  readonly errorTechnicalMessage?: string;
  readonly successMessage?: string;
}

export interface ProviderDeleteResult {
  readonly ok: boolean;
  readonly errorMessage?: string;
  readonly errorTechnicalMessage?: string;
}

export type ProviderCheckScope = "row" | "batch" | "save";
