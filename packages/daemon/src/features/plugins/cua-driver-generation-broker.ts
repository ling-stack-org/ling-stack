import type {
  McpRuntimeStatusSnapshot,
  McpServer,
  ReplaceMcpServerToolInput,
} from "@ling-stack/core";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import type { McpBroker, McpBrokerOptions } from "../../context.js";
import { createMcpAuthStatus, createMcpStatusSnapshot } from "../mcp/status.js";
import type { CuaDriverClientPool } from "./cua-driver-client-pool.js";
import type { CuaDriverLeaseMcpClient } from "./cua-driver-lease-client.js";
import type { CuaDriverLeaseRegistry } from "./cua-driver-lease.js";
import type { LockedComputerControlRegistry } from "../computer-use/locked-control-registry.js";
import { CUA_DRIVER_MCP_SERVER_ID } from "./presets.js";

export type CuaDriverGenerationBrokerErrorCode =
  | "cua_desktop_lease_unavailable"
  | "cua_desktop_lease_stale"
  | "cua_driver_workspace_mismatch";

export class CuaDriverGenerationBrokerError extends Error {
  constructor(readonly code: CuaDriverGenerationBrokerErrorCode) {
    super(code);
    this.name = "CuaDriverGenerationBrokerError";
  }
}

/**
 * Routes the canonical bundled Cua Driver logical MCP id through the current
 * Desktop lease generation. The persisted placeholder transport is never read
 * on this path, so the generic HTTP tools/list fallback is unreachable.
 */
export function createCuaDriverGenerationBroker(input: {
  readonly baseBroker: McpBroker;
  readonly bundledEnabled: boolean;
  readonly workspaceCwd: string;
  readonly leaseRegistry: CuaDriverLeaseRegistry;
  readonly clientPool: CuaDriverClientPool<CuaDriverLeaseMcpClient>;
  readonly lockedControlRegistry?: LockedComputerControlRegistry;
}): McpBroker {
  const useBundledClient = (server: McpServer): boolean =>
    input.bundledEnabled && server.id === CUA_DRIVER_MCP_SERVER_ID;

  return {
    cuaDriverRuntimeAuthority: {
      enabled: input.bundledEnabled,
      workspaceCwd: input.workspaceCwd,
      platform: process.platform,
      hasCurrentLease: () => Boolean(input.leaseRegistry.getCurrent()),
      assertLockedApprovalAllowed: (context) => {
        if (context.serverId !== CUA_DRIVER_MCP_SERVER_ID) return;
        const lease = input.leaseRegistry.getCurrent();
        if (!lease || !input.lockedControlRegistry) return;
        input.lockedControlRegistry.captureActionFence({
          leaseGeneration: lease.generation,
          workspaceCwd: input.workspaceCwd,
          runId: context.runId,
          computerUseSessionId: context.computerUseSessionId,
          toolId: context.toolId,
          toolCallId: context.toolCallId,
          defaultApproval: context.defaultApproval,
        });
      },
    },
    async checkServer(
      server: McpServer,
      options: McpBrokerOptions,
    ): Promise<{ readonly statusSnapshot: McpRuntimeStatusSnapshot }> {
      if (!useBundledClient(server)) {
        return input.baseBroker.checkServer(server, options);
      }
      const now = currentNow(options);
      if (!server.enabled) {
        return { statusSnapshot: disabledSnapshot(server, now) };
      }
      const unavailable = bundledAvailabilityError(input.workspaceCwd, options, input.leaseRegistry);
      if (unavailable) {
        return { statusSnapshot: failedSnapshot(server, now, unavailable) };
      }
      const lease = input.leaseRegistry.getCurrent();
      if (!lease) {
        return {
          statusSnapshot: failedSnapshot(server, now, "cua_desktop_lease_unavailable"),
        };
      }
      let handle: Awaited<ReturnType<typeof input.clientPool.acquire>> | undefined;
      try {
        handle = await input.clientPool.acquire(lease);
        const result = await handle.client.check(
          server,
          now,
          combineAbortSignals(options.signal, handle.signal),
        );
        options.signal?.throwIfAborted();
        assertCurrentLease(input.leaseRegistry, lease);
        return result;
      } catch (error) {
        options.signal?.throwIfAborted();
        rethrowGenerationError(error, input.leaseRegistry, lease);
        return {
          statusSnapshot: failedSnapshot(
            server,
            now,
            error instanceof Error ? error.message : String(error),
          ),
        };
      } finally {
        handle?.release();
      }
    },

    async listTools(
      server: McpServer,
      options: McpBrokerOptions,
    ): Promise<{
      readonly statusSnapshot: McpRuntimeStatusSnapshot;
      readonly tools: readonly ReplaceMcpServerToolInput[];
    }> {
      if (!useBundledClient(server)) {
        return input.baseBroker.listTools(server, options);
      }
      const now = currentNow(options);
      if (!server.enabled) {
        return { statusSnapshot: disabledSnapshot(server, now), tools: [] };
      }
      const unavailable = bundledAvailabilityError(input.workspaceCwd, options, input.leaseRegistry);
      if (unavailable) {
        return { statusSnapshot: failedSnapshot(server, now, unavailable), tools: [] };
      }
      const lease = input.leaseRegistry.getCurrent();
      if (!lease) {
        return {
          statusSnapshot: failedSnapshot(server, now, "cua_desktop_lease_unavailable"),
          tools: [],
        };
      }
      let handle: Awaited<ReturnType<typeof input.clientPool.acquire>> | undefined;
      try {
        handle = await input.clientPool.acquire(lease);
        const result = await handle.client.listTools(
          server,
          now,
          combineAbortSignals(options.signal, handle.signal),
        );
        options.signal?.throwIfAborted();
        assertCurrentLease(input.leaseRegistry, lease);
        return result;
      } catch (error) {
        options.signal?.throwIfAborted();
        rethrowGenerationError(error, input.leaseRegistry, lease);
        return {
          statusSnapshot: failedSnapshot(
            server,
            now,
            error instanceof Error ? error.message : String(error),
          ),
          tools: [],
        };
      } finally {
        handle?.release();
      }
    },

    async callTool(
      server: McpServer,
      options: McpBrokerOptions,
      toolName: string,
      toolInput: unknown,
    ): Promise<PiRunnerMcpToolCallResult> {
      if (!useBundledClient(server)) {
        return input.baseBroker.callTool(server, options, toolName, toolInput);
      }
      if (!server.enabled) {
        throw new CuaDriverGenerationBrokerError("cua_desktop_lease_unavailable");
      }
      const unavailable = bundledAvailabilityError(input.workspaceCwd, options, input.leaseRegistry);
      if (unavailable) {
        throw new CuaDriverGenerationBrokerError(unavailable);
      }
      const lease = input.leaseRegistry.getCurrent();
      if (!lease) {
        throw new CuaDriverGenerationBrokerError("cua_desktop_lease_unavailable");
      }
      assertCurrentLease(input.leaseRegistry, lease);
      options.assertResultCurrent?.();
      const execution = options.lockedControlExecution;
      const actionFence = input.lockedControlRegistry?.captureActionFence({
        leaseGeneration: lease.generation,
        workspaceCwd: options.workspaceCwd,
        runId: execution?.runId,
        computerUseSessionId: execution?.computerUseSessionId,
        toolId: toolName,
        toolCallId: execution?.toolCallId ?? `daemon:${toolName}`,
        defaultApproval: execution?.defaultApproval ?? "deny",
        ...(execution?.approvalId ? { approvalId: execution.approvalId } : {}),
      });
      let handle: Awaited<ReturnType<typeof input.clientPool.acquire>>;
      try {
        handle = await input.clientPool.acquire(lease);
      } catch (error) {
        rethrowGenerationError(error, input.leaseRegistry, lease);
        throw error;
      }
      try {
        const result = await handle.client.callTool(
          server,
          toolName,
          toolInput,
          combineAbortSignals(options.signal, handle.signal),
        );
        options.signal?.throwIfAborted();
        assertCurrentLease(input.leaseRegistry, lease);
        options.assertResultCurrent?.();
        actionFence?.assertCurrent();
        return result;
      } catch (error) {
        rethrowGenerationError(error, input.leaseRegistry, lease);
        throw error;
      } finally {
        handle.release();
      }
    },
  };
}

function bundledAvailabilityError(
  expectedWorkspaceCwd: string,
  options: McpBrokerOptions,
  leaseRegistry: CuaDriverLeaseRegistry,
): CuaDriverGenerationBrokerErrorCode | undefined {
  if (options.workspaceCwd !== expectedWorkspaceCwd) {
    return "cua_driver_workspace_mismatch";
  }
  return leaseRegistry.getCurrent()
    ? undefined
    : "cua_desktop_lease_unavailable";
}

function assertCurrentLease(
  leaseRegistry: CuaDriverLeaseRegistry,
  lease: Parameters<CuaDriverLeaseRegistry["isCurrent"]>[0],
): void {
  if (!leaseRegistry.isCurrent(lease)) {
    throw new CuaDriverGenerationBrokerError("cua_desktop_lease_stale");
  }
}

function rethrowGenerationError(
  error: unknown,
  leaseRegistry: CuaDriverLeaseRegistry,
  lease: Parameters<CuaDriverLeaseRegistry["isCurrent"]>[0],
): void {
  if (error instanceof CuaDriverGenerationBrokerError) {
    throw error;
  }
  if (!leaseRegistry.isCurrent(lease)) {
    throw new CuaDriverGenerationBrokerError("cua_desktop_lease_stale");
  }
}

function currentNow(options: McpBrokerOptions): string {
  return options.now ? options.now() : new Date().toISOString();
}

function disabledSnapshot(server: McpServer, now: string): McpRuntimeStatusSnapshot {
  return createMcpStatusSnapshot({
    server,
    now,
    status: "disabled",
    authStatus: createMcpAuthStatus([]),
    message: "MCP server is disabled.",
  });
}

function failedSnapshot(
  server: McpServer,
  now: string,
  errorCode: string,
): McpRuntimeStatusSnapshot {
  return createMcpStatusSnapshot({
    server,
    now,
    status: "failed",
    authStatus: createMcpAuthStatus([]),
    errorCode,
    message: errorCode,
    toolCount: 0,
  });
}

function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  generationSignal: AbortSignal,
): AbortSignal {
  return callerSignal
    ? AbortSignal.any([callerSignal, generationSignal])
    : generationSignal;
}
