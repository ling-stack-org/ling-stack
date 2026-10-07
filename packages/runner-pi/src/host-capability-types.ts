import type { PiRunnerTask } from "./types.js";

/** Structural adapter boundary; the Daemon validates these against the Contracts catalog. */
export interface PiRunnerHostCapabilityToolDefinition {
  readonly name: "host_open_local_target" | "host_local_network_info";
  readonly capabilityId: "host.open_local_target" | "host.local_network_info";
  readonly contractVersion: 1;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface PiRunnerHostCapabilityCallRequest {
  readonly toolCallId: string;
  readonly toolName: PiRunnerHostCapabilityToolDefinition["name"];
  readonly capabilityId: PiRunnerHostCapabilityToolDefinition["capabilityId"];
  readonly contractVersion: 1;
  readonly input: unknown;
  readonly runId: string;
  readonly attemptId: string;
  readonly approvalId: string;
  readonly task: PiRunnerTask;
  readonly cwd: string;
  readonly signal: AbortSignal;
}
