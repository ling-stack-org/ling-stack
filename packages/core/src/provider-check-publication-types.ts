import type { ProviderCheckResult, ProviderPreset } from "./provider-types.js";
import type { ControlPlaneEvent } from "./run-types.js";

export type ProviderCheckSource = "manual" | "startup" | "model_import";

/** Host-only monotonically increasing authority. Never expose in public presets. */
export interface ProviderCheckAuthority {
  readonly configRevision: number;
  readonly requestRevision: number;
  readonly publishedRevision: number;
}

export interface ProviderCheckRequestTicket {
  readonly providerId: string;
  readonly configRevision: number;
  readonly requestRevision: number;
  readonly source: ProviderCheckSource;
}

export interface ProviderCheckAdmission {
  readonly provider: ProviderPreset;
  readonly ticket: ProviderCheckRequestTicket;
}

export type ProviderCheckPublicationResult =
  | { readonly status: "deleted" | "config_changed" | "superseded" | "already_published" }
  | {
      readonly status: "published";
      readonly provider: ProviderPreset;
      /** Returned only after the result, ticket consumption and event COMMIT. */
      readonly event: ControlPlaneEvent;
    };

export interface ProviderCheckPublicationStore {
  getProviderCheckAuthority(providerId: string): ProviderCheckAuthority | undefined;
  beginProviderCheckRequest(providerId: string, source: ProviderCheckSource, pendingCheck?: ProviderCheckResult): ProviderCheckAdmission | undefined;
  commitProviderCheckResult(ticket: ProviderCheckRequestTicket, result: ProviderCheckResult, cwd: string): ProviderCheckPublicationResult;
}
