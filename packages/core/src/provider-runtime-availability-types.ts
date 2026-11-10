import type { AvailabilityIncident, CreateAvailabilityIncidentInput } from "./channel-team-types.js";
import type { ProviderApi, ProviderKind } from "./provider-types.js";

/** Safe historical lineage only. This is not credential or current-scope authority. */
export interface ProviderRuntimeAvailabilityIncidentSource {
  readonly observationId: string;
  readonly invocationId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly origin: "task" | "reviewer" | "reply" | "route" | "intent";
  readonly admittedAt: string;
  readonly settledAt: string;
  readonly identity: {
    readonly providerPresetId: string;
    readonly providerKind: ProviderKind;
    readonly providerApi: ProviderApi;
    readonly modelId: string;
    readonly configRevision: number;
  };
}

export interface CreateProviderRuntimeAvailabilityIncidentInput {
  readonly incident: CreateAvailabilityIncidentInput;
  readonly source: ProviderRuntimeAvailabilityIncidentSource;
}

declare const availabilityIncidentCursorBrand: unique symbol;
/** Opaque, process-local cursor; valid only on its owning Store with its original lanes/now. */
export interface AvailabilityIncidentCandidateCursor {
  readonly [availabilityIncidentCursorBrand]: true;
}

export interface ListAvailabilityIncidentCandidatesOptions {
  readonly now: string;
  readonly agentId?: string;
  readonly providerPresetId?: string;
  readonly pageSize?: number;
  readonly cursor?: AvailabilityIncidentCandidateCursor;
}

/** Private Host candidate, deliberately separate from the public historical incident DTO. */
export interface AvailabilityIncidentCandidate {
  readonly incident: AvailabilityIncident;
  readonly provenance: "generic" | "provider_runtime" | "legacy_unclassified";
  readonly source?: ProviderRuntimeAvailabilityIncidentSource;
}

export interface AvailabilityIncidentCandidatePage {
  readonly candidates: readonly AvailabilityIncidentCandidate[];
  readonly nextCursor?: AvailabilityIncidentCandidateCursor;
}
