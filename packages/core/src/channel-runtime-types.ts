import { randomUUID } from "node:crypto";
import type { StateEntityType, StateTransitionActor } from "./state-machines.js";

export type ChannelSourceKind = "local" | "slack" | "feishu" | "github" | "email" | "custom";

export interface ChannelEventInput {
  readonly sourceId: string;
  readonly sourceKind: ChannelSourceKind;
  readonly channelId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
  readonly createdAt: string;
}

export interface ChannelSourceAdapter {
  readonly id: string;
  readonly kind: ChannelSourceKind;
  normalizeEvent(input: unknown): ChannelEventInput;
  acknowledge?(eventId: string): Promise<void>;
}

export type ResourceType =
  | "channel"
  | "bound_path"
  | "workspace"
  | "provider"
  | "task"
  | "workflow_step"
  | "external_source"
  | "external_subject"
  | "external_workspace";

export type ResourceLeaseOwnerType = "run" | "workflow_step" | "work_unit_attempt" | "system";

export type ResourceLeaseStatus = "active" | "released" | "expired";

export interface ResourceLease {
  readonly id: string;
  readonly workspaceId: string;
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly ownerType: ResourceLeaseOwnerType;
  readonly ownerId: string;
  readonly status: ResourceLeaseStatus;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly lastRenewedAt?: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
}

export interface CreateResourceLeaseInput {
  readonly workspaceId: string;
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly ownerType: ResourceLeaseOwnerType;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly lastRenewedAt?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
}

export interface ListResourceLeasesOptions {
  readonly status?: ResourceLeaseStatus;
  readonly ownerType?: ResourceLeaseOwnerType;
  readonly ownerId?: string;
  readonly resourceType?: ResourceType;
  readonly resourceKey?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly limit?: number;
}

export interface StateTransitionEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: StateEntityType;
  readonly entityId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly event: string;
  readonly actor: StateTransitionActor;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly createdAt: string;
}

export interface CreateStateTransitionEventInput {
  readonly workspaceId: string;
  readonly entityType: StateEntityType;
  readonly entityId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly event: string;
  readonly actor: StateTransitionActor;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly createdAt: string;
}

export interface ListStateTransitionEventsOptions {
  readonly entityType?: StateEntityType;
  readonly entityId?: string;
  readonly limit?: number;
}

export function createResourceLeaseId(): string {
  return `lease_${randomUUID()}`;
}

export function createStateTransitionEventId(): string {
  return `transition_${randomUUID()}`;
}
