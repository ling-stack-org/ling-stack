import type { ControlPlaneEvent } from "./run-types.js";
import type { McpRuntimeStatusSnapshot, McpServer, McpTool, ReplaceMcpServerToolInput } from "./mcp-types.js";

export type McpMetadataRequestKind = "check" | "sync-tools";

/** Host-only admission snapshot; never serialize this ticket to public API/SSE. */
export interface McpMetadataRequestTicket {
  readonly server: McpServer;
  readonly kind: McpMetadataRequestKind;
  readonly requestRevision: number;
  readonly serverRevision: number;
  readonly toolsRevision: number;
}

export interface CommitMcpMetadataResultInput {
  readonly request: McpMetadataRequestTicket;
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
  readonly tools?: readonly ReplaceMcpServerToolInput[];
  readonly cwd: string;
  readonly now: string;
}

export type CommitMcpMetadataResult =
  | { readonly published: false; readonly reason: "deleted" | "server_changed" | "tools_changed" | "superseded" | "already_published" }
  | {
      readonly published: true;
      readonly server: McpServer;
      readonly statusSnapshot: McpRuntimeStatusSnapshot;
      readonly tools?: readonly McpTool[];
      /** Durable event returned only after COMMIT; caller may broadcast it. */
      readonly event: ControlPlaneEvent;
    };
