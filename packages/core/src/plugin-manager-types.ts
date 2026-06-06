import { randomUUID } from "node:crypto";
import type { McpRuntimeStatusSnapshot, McpServer, McpTool } from "./mcp-types.js";

export type ManagedPluginSourceKind = "built-in" | "bundled" | "trusted-local-preset";
export type ManagedPluginStatus = "available" | "enabled" | "disabled" | "blocked";
export type ManagedPluginHealthStatus = "unknown" | "ready" | "failed" | "disabled" | "expired";

export type ManagedPluginContributionKind =
  | "mcp-server"
  | "tool"
  | "skill-pack"
  | "runner"
  | "provider"
  | "channel-source"
  | "memory"
  | "automation"
  | "ui-feature";

export type ManagedPluginSideEffectLevel = "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";
export type ManagedPluginDefaultApproval = "allow" | "ask" | "deny";

export interface ManagedPluginDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly contributions: readonly ManagedPluginContributionDescriptor[];
  readonly requiredSecrets?: readonly ManagedPluginSecretRequirement[];
  readonly defaultApprovals?: readonly ManagedPluginApprovalDefault[];
  readonly healthChecks?: readonly ManagedPluginHealthCheck[];
  readonly defaultEnabled?: boolean;
}

export interface ManagedPluginContributionDescriptor {
  readonly kind: ManagedPluginContributionKind;
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly sideEffectLevel?: ManagedPluginSideEffectLevel;
  readonly defaultApproval?: ManagedPluginDefaultApproval;
}

export interface ManagedPluginSecretRequirement {
  readonly ref: string;
  readonly label: string;
  readonly purpose?: string;
  readonly required?: boolean;
}

export interface ManagedPluginApprovalDefault {
  readonly contributionId: string;
  readonly decision: ManagedPluginDefaultApproval;
  readonly reason?: string;
}

export interface ManagedPluginHealthCheck {
  readonly id: string;
  readonly label: string;
  readonly kind: "descriptor" | "binary" | "mcp";
}

export interface ManagedPluginRecord {
  readonly id: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly version: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly descriptor: ManagedPluginDescriptor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedPluginContributionRecord {
  readonly pluginId: string;
  readonly contributionKind: ManagedPluginContributionKind;
  readonly contributionId: string;
  readonly linkedResourceId?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedPluginHealthSnapshot {
  readonly pluginId: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly status: ManagedPluginHealthStatus;
  readonly message?: string;
  readonly details?: unknown;
}

export type ManagedPluginEventType =
  | "enabled"
  | "disabled"
  | "preset_applied"
  | "checked"
  | "contribution_linked"
  | "contribution_disabled";

export interface ManagedPluginEvent {
  readonly id: string;
  readonly pluginId: string;
  readonly type: ManagedPluginEventType;
  readonly actor: "local-user" | "system";
  readonly message?: string;
  readonly data?: unknown;
  readonly createdAt: string;
}

export interface ListManagedPluginsOptions {
  readonly enabled?: boolean;
  readonly sourceKind?: ManagedPluginSourceKind;
  readonly limit?: number;
}

export interface UpsertManagedPluginInput {
  readonly id: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly version: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly descriptor: ManagedPluginDescriptor;
}

export interface UpdateManagedPluginInput {
  readonly enabled?: boolean;
  readonly disabledReason?: string | null;
  readonly descriptor?: ManagedPluginDescriptor;
  readonly version?: string;
}

export interface UpsertManagedPluginContributionInput {
  readonly contributionKind: ManagedPluginContributionKind;
  readonly contributionId: string;
  readonly linkedResourceId?: string;
  readonly enabled?: boolean;
}

export interface CreateManagedPluginEventInput {
  readonly id?: string;
  readonly pluginId: string;
  readonly type: ManagedPluginEventType;
  readonly actor?: "local-user" | "system";
  readonly message?: string;
  readonly data?: unknown;
}

export interface ListManagedPluginEventsOptions {
  readonly pluginId?: string;
  readonly limit?: number;
}

export interface ManagedPluginLinkedResource {
  readonly kind: ManagedPluginContributionKind;
  readonly id: string;
  readonly present: boolean;
  readonly enabled?: boolean;
  readonly displayName?: string;
}

export interface ManagedPluginContributionView extends ManagedPluginContributionDescriptor {
  readonly linkedResourceId?: string;
  readonly linkedResourcePresent?: boolean;
  readonly enabled: boolean;
}

export interface ManagedPluginView {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly status: ManagedPluginStatus;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly contributions: readonly ManagedPluginContributionView[];
  readonly requiredSecrets?: readonly ManagedPluginSecretRequirement[];
  readonly defaultApprovals?: readonly ManagedPluginApprovalDefault[];
  readonly health?: ManagedPluginHealthSnapshot;
  readonly linkedResources: readonly ManagedPluginLinkedResource[];
  readonly events?: readonly ManagedPluginEvent[];
  readonly disabledReason?: string;
  readonly actions: {
    readonly canEnable: boolean;
    readonly canDisable: boolean;
    readonly canCheck: boolean;
    readonly canApplyPreset: boolean;
  };
}

export interface ManagedPluginListResponse {
  readonly cwd: string;
  readonly plugins: readonly ManagedPluginView[];
}

export interface ManagedPluginDetailResponse {
  readonly plugin: ManagedPluginView;
}

export interface ManagedPluginMutationResponse {
  readonly plugin: ManagedPluginView;
}

export interface ManagedPluginCheckResponse {
  readonly plugin: ManagedPluginView;
  readonly health: ManagedPluginHealthSnapshot;
}

export interface ManagedPluginApplyPresetRequest {
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ManagedPluginDisableRequest {
  readonly reason?: string;
}

export interface ManagedPluginApplyPresetResponse {
  readonly plugin: ManagedPluginView;
  readonly linkedMcpServer?: McpServer;
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
}

export function createManagedPluginEventId(): string {
  return `plugin_event_${randomUUID()}`;
}
