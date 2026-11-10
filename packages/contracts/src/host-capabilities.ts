import { isChannelOperationRelativePathV1 } from "./channel-operation-bindings.js";

export type HostCapabilityIdV1 = "host.open_local_target" | "host.local_network_info";
export type HostCapabilityToolNameV1 = "host_open_local_target" | "host_local_network_info";
export const HOST_CAPABILITY_BRIDGE_PROTOCOL_V1 = "ling-host-capability-bridge/v1" as const;
export const HOST_CAPABILITY_BRIDGE_MAX_FRAME_BYTES = 64 * 1024;
export type HostCapabilityCallV1 =
  | { readonly contractVersion: 1; readonly capabilityId: "host.open_local_target"; readonly input: { readonly path: string } }
  | { readonly contractVersion: 1; readonly capabilityId: "host.local_network_info";
      readonly input: { readonly family: "all" | "IPv4" | "IPv6"; readonly includeLoopback: boolean } };

/** Schema discovery only. No executor, scope, approval, credential or owner can be supplied here. */
export interface HostCapabilityToolDefinitionV1 {
  readonly name: HostCapabilityToolNameV1;
  readonly capabilityId: HostCapabilityIdV1;
  readonly contractVersion: 1;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface HostCapabilityBridgeAvailabilityV1 {
  readonly protocol: typeof HOST_CAPABILITY_BRIDGE_PROTOCOL_V1;
  readonly desktopInstanceId: string;
  readonly generation: number;
  readonly capabilities: readonly HostCapabilityIdV1[];
  readonly checkedAt: string;
}

export type HostLocalTargetPresentationV1 = "interactive_html" | "read_only_text" | "image";

/**
 * Process-local command from the daemon to its authenticated Desktop owner.
 * absolutePath and workspaceRoot are Host data, never model input or durable
 * conversation evidence.
 */
export interface HostOpenLocalTargetCommandV1 {
  readonly protocol: typeof HOST_CAPABILITY_BRIDGE_PROTOCOL_V1;
  readonly id: string;
  readonly capabilityId: "host.open_local_target";
  readonly path: string;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly presentation: HostLocalTargetPresentationV1;
  readonly runId: string;
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly approvalId: string;
  readonly deadlineAt: string;
  readonly idempotencyKey: string;
}

export type HostCapabilityBridgeCommandV1 = HostOpenLocalTargetCommandV1;

export type HostCapabilityBridgeResultV1 =
  | {
      readonly protocol: typeof HOST_CAPABILITY_BRIDGE_PROTOCOL_V1;
      readonly id: string;
      readonly ok: true;
      readonly receipt: import("./host-open-receipt.js").HostOpenLocalTargetReceiptV1;
    }
  | {
      readonly protocol: typeof HOST_CAPABILITY_BRIDGE_PROTOCOL_V1;
      readonly id: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export const hostCapabilityToolsV1: readonly HostCapabilityToolDefinitionV1[] = freeze([
  { name: "host_open_local_target", capabilityId: "host.open_local_target", contractVersion: 1,
    description: "Ask the Ling Host to display an existing workspace file. Requires separate approval and a supported Host viewer. Does not execute a command. A launch receipt does not prove the window is visible.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", minLength: 1, maxLength: 4096, description: "Literal canonical workspace-relative file path. No URL, command or owner IDs." },
    } } },
  { name: "host_local_network_info", capabilityId: "host.local_network_info", contractVersion: 1,
    description: "Ask the Ling Host for local interface addresses with separate approval. Does not contact the network, discover public egress IP, or return MAC addresses or credentials.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      family: { type: "string", enum: ["all", "IPv4", "IPv6"], default: "all" },
      includeLoopback: { type: "boolean", default: false },
    } } },
]);

export function isHostCapabilityToolNameV1(value: unknown): value is HostCapabilityToolNameV1 {
  return hostCapabilityToolsV1.some(tool => tool.name === value);
}

/** Validate persisted descriptors against the same closed catalog used at discovery. */
export function isHostCapabilityToolDefinitionV1(value: unknown): value is HostCapabilityToolDefinitionV1 {
  if (!record(value)) return false;
  const expected = hostCapabilityToolsV1.find(tool => tool.name === value.name);
  return expected !== undefined && equal(value, expected);
}

/** Validate model input again at the Host boundary, without trusting the SDK schema check. */
export function readHostCapabilityCallV1(toolName: unknown, value: unknown): HostCapabilityCallV1 {
  if (!record(value)) throw new Error("Host capability input must be an object.");
  if (toolName === "host_open_local_target") {
    if (Object.keys(value).length !== 1 || !isChannelOperationRelativePathV1(value.path) || value.path.length > 4096) {
      throw new Error("Host open input requires only a canonical workspace-relative file path.");
    }
    return { contractVersion: 1, capabilityId: "host.open_local_target", input: { path: value.path } };
  }
  if (toolName === "host_local_network_info") {
    if (Object.keys(value).some(key => key !== "family" && key !== "includeLoopback") ||
      value.family !== undefined && value.family !== "all" && value.family !== "IPv4" && value.family !== "IPv6" ||
      value.includeLoopback !== undefined && typeof value.includeLoopback !== "boolean") {
      throw new Error("Invalid Host local network input.");
    }
    return { contractVersion: 1, capabilityId: "host.local_network_info",
      input: { family: value.family ?? "all", includeLoopback: value.includeLoopback ?? false } };
  }
  throw new Error("Unsupported Host capability tool.");
}

export function parseHostCapabilityBridgeAvailabilityV1(value: unknown): HostCapabilityBridgeAvailabilityV1 {
  if (!record(value) || value.protocol !== HOST_CAPABILITY_BRIDGE_PROTOCOL_V1
    || !identifier(value.desktopInstanceId) || !positiveInteger(value.generation)
    || !Array.isArray(value.capabilities) || value.capabilities.length > hostCapabilityToolsV1.length
    || new Set(value.capabilities).size !== value.capabilities.length
    || !value.capabilities.every((item): item is HostCapabilityIdV1 =>
      item === "host.open_local_target" || item === "host.local_network_info")
    || !timestamp(value.checkedAt)) throw new Error("host_capability_availability_invalid");
  return {
    protocol: HOST_CAPABILITY_BRIDGE_PROTOCOL_V1,
    desktopInstanceId: value.desktopInstanceId,
    generation: value.generation,
    capabilities: [...value.capabilities],
    checkedAt: value.checkedAt,
  };
}

export function parseHostCapabilityBridgeCommandV1(value: unknown): HostCapabilityBridgeCommandV1 {
  if (!record(value) || value.protocol !== HOST_CAPABILITY_BRIDGE_PROTOCOL_V1
    || value.capabilityId !== "host.open_local_target" || !identifier(value.id)
    || !isChannelOperationRelativePathV1(value.path) || value.path.length > 4096
    || !absolutePath(value.absolutePath) || !absolutePath(value.workspaceRoot)
    || (value.presentation !== "interactive_html" && value.presentation !== "read_only_text" && value.presentation !== "image")
    || ![value.runId, value.attemptId, value.toolCallId, value.approvalId, value.idempotencyKey].every(identifier)
    || !timestamp(value.deadlineAt)) throw new Error("host_capability_command_invalid");
  return value as unknown as HostCapabilityBridgeCommandV1;
}

export function parseHostCapabilityBridgeResultV1(value: unknown): HostCapabilityBridgeResultV1 {
  if (!record(value) || value.protocol !== HOST_CAPABILITY_BRIDGE_PROTOCOL_V1 || !identifier(value.id)
    || typeof value.ok !== "boolean") throw new Error("host_capability_result_invalid");
  if (value.ok) {
    // Keep the wire parser closed without importing runtime authorization here.
    if (!record(value.receipt)) throw new Error("host_capability_result_invalid");
    return value as unknown as HostCapabilityBridgeResultV1;
  }
  if (!record(value.error) || !errorCode(value.error.code) || typeof value.error.message !== "string"
    || value.error.message.length < 1 || value.error.message.length > 512) throw new Error("host_capability_result_invalid");
  return value as unknown as HostCapabilityBridgeResultV1;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8192
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) && !/[\u0000-\u001f\u007f]/u.test(value);
}
function errorCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_:-]{1,96}$/iu.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function equal(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (record(left) && record(right)) return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  return left === right;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
