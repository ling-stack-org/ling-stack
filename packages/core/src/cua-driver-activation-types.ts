import type {
  ManagedPluginEventType,
  ManagedPluginHealthSnapshot,
} from "./plugin-manager-types.js";
import type {
  McpRuntimeStatusSnapshot,
  ReplaceMcpServerToolInput,
} from "./mcp-types.js";

/** Durable fence row for the bundled Cua Driver capability. */
export interface CuaDriverActivationState {
  readonly pluginId: string;
  readonly requestedEnabled: boolean;
  readonly requestedRevision: number;
  readonly activationEpoch: number;
  readonly updatedAt: string;
}

export type CuaDriverActivationCrashPoint =
  | "after_tools"
  | "after_status"
  | "after_plugin"
  | "after_contribution"
  | "after_mcp"
  | "after_health"
  | "after_event"
  | "after_fence";

export interface CuaDriverActivationFenceExpectation {
  readonly requestedRevision: number;
  readonly activationEpoch: number;
}

/**
 * One atomic projection of intent, readiness and effective tool availability.
 * Callers must provide the complete desired projection; omitted effective state
 * is intentionally not supported so a late result cannot partially re-enable
 * the provider.
 */
export interface CommitCuaDriverActivationInput {
  readonly pluginId: string;
  readonly mcpServerId: string;
  readonly now: string;
  readonly expected: CuaDriverActivationFenceExpectation;
  readonly requestedEnabled: boolean;
  readonly requestedRevision: number;
  readonly activationEpoch: number;
  readonly effectiveEnabled: boolean;
  readonly pluginEnabled: boolean;
  readonly contributionEnabled: boolean;
  readonly mcpServerEnabled: boolean;
  readonly tools: readonly ReplaceMcpServerToolInput[];
  /** `null` removes the persisted runtime status snapshot. */
  readonly statusSnapshot: McpRuntimeStatusSnapshot | null;
  /** `undefined` preserves health; `null` removes it. */
  readonly healthSnapshot?: ManagedPluginHealthSnapshot | null;
  readonly disabledReason?: string | null;
  readonly event?: {
    readonly type: ManagedPluginEventType;
    readonly actor?: "local-user" | "system";
    readonly message?: string;
    readonly data?: unknown;
  };
  /** Test-only fault injection point. Never set in production callers. */
  readonly crashAfter?: CuaDriverActivationCrashPoint;
}

export interface CommitCuaDriverActivationResult {
  readonly committed: boolean;
  readonly state?: CuaDriverActivationState;
}
