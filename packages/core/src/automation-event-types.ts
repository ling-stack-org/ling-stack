import type { AutomationDefinition, AutomationRun } from "./automation-types.js";

export interface AutomationEventRule {
  readonly automationId: string;
  readonly types: readonly string[];
  readonly predicates?: readonly { readonly path: string; readonly equals: string | number | boolean | null }[];
  readonly destinationIds?: readonly string[];
}

/** A source binds authenticated data to existing automation and destination authority. */
export interface AutomationEventSource {
  readonly id: string;
  readonly label: string;
  readonly adapter: "webhook" | "github" | "business";
  readonly enabled: boolean;
  readonly secretRefs: readonly string[];
  readonly repository?: string;
  readonly rules: readonly AutomationEventRule[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type PutAutomationEventSource = Omit<AutomationEventSource, "revision" | "createdAt" | "updatedAt">;
export interface AutomationEventEnvelope {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly payloadDigest: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface AutomationEventDispatch {
  readonly id: string;
  readonly eventId: string;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly automationId: string;
  readonly definitionDigest: string;
  readonly destinationIds: readonly string[];
  readonly status: "queued" | "dispatching" | "linked" | "failed";
  readonly attempts: number;
  readonly leaseToken?: string;
  readonly leaseUntil?: string;
  readonly automationRunId?: string;
  readonly error?: string;
}
export interface AutomationDelivery {
  readonly id: string;
  readonly dispatchId: string;
  readonly runId: string;
  readonly destinationId: string;
  readonly status: "queued" | "sending" | "delivered" | "unknown" | "failed";
  readonly attempts: number;
  readonly availableAt: string;
  readonly leaseToken?: string;
  readonly receipt?: string;
  readonly updatedAt: string;
}
export interface AutomationEventStore {
  putAutomationEventSource(input: PutAutomationEventSource, expectedRevision: number | undefined, now: string): AutomationEventSource;
  getAutomationEventSource(id: string): AutomationEventSource | undefined;
  listAutomationEventSources(): AutomationEventSource[];
  acceptAutomationEvent(input: Omit<AutomationEventEnvelope, "id" | "receivedAt">, sourceRevision: number, now: string): { event: AutomationEventEnvelope; duplicate: boolean };
  listAutomationEvents(limit?: number): AutomationEventEnvelope[];
  getAutomationEvent(id: string): AutomationEventEnvelope | undefined;
  claimAutomationEventDispatch(now: string): AutomationEventDispatch | undefined;
  finishAutomationEventDispatch(id: string, leaseToken: string, input: { status: "queued" | "linked" | "failed"; automationRunId?: string; error?: string }, now: string): boolean;
  listAutomationEventDispatches(limit?: number): AutomationEventDispatch[];
  getAutomationEventDispatch(id: string): AutomationEventDispatch | undefined;
  getAutomationRunResultText(runId: string): string | undefined;
  reconcileAutomationDeliveries(now: string): void;
  claimAutomationDelivery(now: string): AutomationDelivery | undefined;
  settleAutomationDelivery(id: string, leaseToken: string, input: { status: "queued" | "delivered" | "unknown" | "failed"; receipt: string; availableAt?: string }, now: string): boolean;
  reconcileAutomationDelivery(id: string, expectedUpdatedAt: string, decision: "delivered" | "retry" | "failed", reason: string, now: string): AutomationDelivery;
  listAutomationDeliveries(limit?: number): AutomationDelivery[];
}

export type AutomationEventPorts = Pick<import("./run-types.js").RunStore,
  "getAutomationDefinition" | "getAutomationRun" | "getRun" | "findAutomationRunByIdempotencyKey">;
export const automationEventRunKey = (dispatchId: string): string => `automation-event:${dispatchId}`;
export const automationDefinitionDigestInput = (definition: AutomationDefinition): unknown => ({
  ...definition, lastRunId: undefined, nextRunAt: undefined, lastErrorMessage: undefined, updatedAt: undefined,
});
export function automationEventRunSettled(run: AutomationRun): boolean {
  return ["succeeded", "failed", "cancelled"].includes(run.status);
}
