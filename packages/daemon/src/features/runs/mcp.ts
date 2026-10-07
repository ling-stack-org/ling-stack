import { createHash } from "node:crypto";
import {
  type McpServer,
  type McpTool,
  type RunMcpServerAccessSnapshot,
  type RunMcpToolAccessSnapshot,
  type RunStore,
  type SecretResolver,
  redactSecrets,
} from "@ling-stack/core";
import type {
  PiRunnerMcpToolCallRequest,
  PiRunnerMcpToolCallResult,
  PiRunnerMcpToolDefinition,
  PiRunnerRunOptions,
} from "@ling-stack/runner-pi";
import type { McpBroker } from "../../context.js";
import { mcpServerSecretRefs, mcpServerSecretStatuses } from "../mcp/secrets.js";
import { deriveMcpServerStatus } from "../mcp/status.js";
import {
  assertMcpResultAuthorityCurrent,
  captureMcpResultAuthority,
} from "../mcp/result-authority.js";
import { removeUndefined } from "../../shared/validation.js";
import type { AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import { assertMcpBrokerHostAdmission, captureRegisteredMcpBrokerCallTool, findHostOfficeLocalFactory } from "../mcp/broker.js";
import { reserveHostMcpOperation } from "../mcp/host-operation.js";
import { assertHostOfficeLocalMcpAdmission, assertHostOfficeLocalMcpResultCurrent, bindHostOfficeLocalMcpAuthority,
  finishHostOfficeLocalMcpOperation, isOfficeLocalArtifactToolName, reserveHostOfficeLocalMcpOperation } from "../mcp/office-local-mcp-operation.js";
import type { RunRequest } from "./schemas.js";

export function resolveMcpToolAccessForRun(
  store: RunStore,
  secretResolver: SecretResolver,
  runRequest: RunRequest,
  resolveTeammateId: (teammateId: string) => string | undefined,
): RunMcpToolAccessSnapshot {
  if (!runRequest.teammateId) {
    return { servers: [], totalToolCount: 0 };
  }

  const teammateId = resolveTeammateId(runRequest.teammateId) ?? runRequest.teammateId;
  const servers: RunMcpServerAccessSnapshot[] = [];
  let totalToolCount = 0;

  for (const binding of store.listTeammateMcpBindings(teammateId)) {
    if (!binding.enabled) {
      continue;
    }
    const server = store.getMcpServer(binding.serverId);
    if (!server?.enabled) {
      continue;
    }
    const tools = store
      .listMcpTools({ serverId: server.id, enabled: true, limit: 500 })
      .filter((tool) => isMcpToolAuthorizedForRun(server, binding, tool))
      .map((tool) => {
        const approval = binding.approvalOverrides[tool.rawName] ?? tool.defaultApproval;
        return removeUndefined({
          rawName: tool.rawName,
          registeredName: createMcpRunnerToolName(server.id, tool.rawName),
          displayName: tool.displayName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          callableNamespace: tool.callableNamespace,
          callableName: tool.callableName,
          sideEffectLevel: tool.sideEffectLevel,
          approval,
        });
      });
    if (tools.length === 0) {
      continue;
    }

    const secretRefs = mcpServerSecretRefs(server);
    const secretStatuses = mcpServerSecretStatuses(server, secretResolver);
    const configuredSecretNames = secretRefs
      .filter((_, index) => secretStatuses[index]?.configured === true)
      .map((item) => item.destination);
    const missingSecretNames = secretRefs
      .filter((_, index) => secretStatuses[index]?.configured !== true)
      .map((item) => item.destination);
    const missingSecretRefs = secretStatuses.filter((status) => !status.configured).map((status) => status.ref);
    const legacySecretMigrationRequired = store.countLegacyMcpServerSecrets(server.id) > 0 || hasLegacyMcpSecretConfig(server);
    const statusSnapshot = store.getMcpStatusSnapshot(server.id, new Date().toISOString());
    totalToolCount += tools.length;
    servers.push({
      serverId: server.id,
      displayName: server.displayName,
      transportType: server.transport.type,
      required: server.required,
      status: deriveMcpServerStatus(statusSnapshot, server.status),
      configuredSecretNames,
      missingSecretNames,
      secretStatuses,
      missingSecretRefs,
      legacySecretMigrationRequired,
      tools,
    });
  }

  return {
    teammateId,
    servers,
    totalToolCount,
  };
}

export function createPiRunnerMcpToolDefinitions(access: RunMcpToolAccessSnapshot): PiRunnerMcpToolDefinition[] {
  return access.servers.flatMap((server) =>
    server.tools.map((tool) => ({
      registeredName: tool.registeredName,
      serverId: server.serverId,
      rawName: tool.rawName,
      displayName: tool.displayName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      sideEffectLevel: tool.sideEffectLevel,
      defaultApproval: tool.approval,
    })),
  );
}

export function createMcpToolCallHandler(
  store: RunStore,
  secretResolver: SecretResolver,
  mcpBroker: McpBroker,
  tools: readonly PiRunnerMcpToolDefinition[],
  options: {
    readonly runId?: string;
    readonly hostOperationTracker?: AttemptHostOperationTracker;
    /** Trusted late Host composition only; capture once at actual callback entry. */
    readonly getHostOperationTracker?: () => AttemptHostOperationTracker | undefined;
    readonly onStart?: (input: {
      readonly request: PiRunnerMcpToolCallRequest;
      readonly definition: PiRunnerMcpToolDefinition;
    }) => void;
    readonly onResult?: (input: {
      readonly request: PiRunnerMcpToolCallRequest;
      readonly definition: PiRunnerMcpToolDefinition;
      readonly result: PiRunnerMcpToolCallResult;
    }) => void;
  } = {},
): NonNullable<PiRunnerRunOptions["onMcpToolCall"]> {
  const byRegisteredName = new Map(tools.map((tool) => [tool.registeredName, tool]));
  return async (request) => {
    // Parent and connection producer are reserved before the first await.
    const tracker = options.hostOperationTracker ?? options.getHostOperationTracker?.();
    const capturedTool = byRegisteredName.get(request.registeredName);
    const officeLocalOperation = tracker && capturedTool && isOfficeLocalArtifactToolName(capturedTool.rawName)
      && findHostOfficeLocalFactory(mcpBroker, capturedTool.serverId, capturedTool.rawName, store.paths.cwd)
      ? reserveHostOfficeLocalMcpOperation({ broker: mcpBroker, tracker, store, workspaceCwd: store.paths.cwd,
        toolCallId: request.toolCallId, toolName: capturedTool.rawName, input: request.input,
        signal: request.signal, approval: capturedTool.defaultApproval }) : undefined;
    const hostOperation = tracker && !officeLocalOperation ? reserveHostMcpOperation(tracker, request.toolCallId) : undefined;
    try {
      request.signal?.throwIfAborted();
      const tool = capturedTool;
      if (!tool) {
        throw new Error(`MCP tool is not authorized for this run: ${request.registeredName}`);
      }
      const { server, authority } = captureMcpResultAuthority(store, tool.serverId, tool.rawName);
      if (officeLocalOperation) {
        assertHostOfficeLocalMcpAdmission(officeLocalOperation, mcpBroker, server.id, tool.rawName);
        bindHostOfficeLocalMcpAuthority(officeLocalOperation, authority);
      }
      if (hostOperation) assertMcpBrokerHostAdmission(mcpBroker, server);
      try {
        options.onStart?.({ request, definition: tool });
      } catch {
        // Projection observers are best-effort and must not alter the authoritative MCP call.
      }
      // Observers are not dispatch authority. A replacement method must never
      // get invoked just because the original factory was checked before it.
      if (officeLocalOperation) assertHostOfficeLocalMcpResultCurrent(officeLocalOperation);
      const callTool = officeLocalOperation ? captureRegisteredMcpBrokerCallTool(mcpBroker) : mcpBroker.callTool;
      const callArguments: Parameters<McpBroker["callTool"]> = [server, {
        secretResolver,
        workspaceCwd: store.paths.cwd,
        signal: request.signal,
        runId: officeLocalOperation ? tracker!.source.runId : options.runId,
        toolCallId: request.toolCallId,
        ...(officeLocalOperation ? { officeLocalOperation } : { hostOperation }),
        assertResultCurrent: () => {
          assertMcpResultAuthorityCurrent(store, authority);
        },
        ...(options.runId ? {
          lockedControlExecution: {
            runId: options.runId,
            computerUseSessionId: `computer_use_${options.runId}`,
            toolCallId: request.toolCallId,
            defaultApproval: request.defaultApproval,
          },
        } : {}),
      }, tool.rawName, request.input];
      const result: PiRunnerMcpToolCallResult = await Reflect.apply(callTool, mcpBroker, callArguments);
      request.signal?.throwIfAborted();
      hostOperation?.assertMayPrepare();
      if (officeLocalOperation) assertHostOfficeLocalMcpResultCurrent(officeLocalOperation);
      // The production brokers check at the transport boundary. Recheck here as
      // the consumer boundary so an injected/custom broker cannot omit the fence.
      assertMcpResultAuthorityCurrent(store, authority);
      const redactedResult = redactSecrets(
        result,
        collectMcpSecretValuesForServer(server, secretResolver),
      ) as PiRunnerMcpToolCallResult;
      try {
        options.onResult?.({ request, definition: tool, result: redactedResult });
      } catch {
        // Projection observers are best-effort and must not alter the authoritative MCP result.
      }
      return redactedResult;
    } finally {
      // Neither SDK result, callback return nor connection close is a remote
      // whole-operation receipt. Entered operations remain durable unknown.
      hostOperation?.finish();
      if (officeLocalOperation) finishHostOfficeLocalMcpOperation(officeLocalOperation);
    }
  };
}

function collectMcpSecretValuesForServer(
  server: McpServer,
  secretResolver: SecretResolver,
): readonly (string | undefined)[] {
  return mcpServerSecretRefs(server).map((item) => secretResolver.resolve(item.ref, item.purpose).value);
}

function isMcpToolAuthorizedForRun(
  server: McpServer,
  binding: ReturnType<RunStore["listTeammateMcpBindings"]>[number],
  tool: McpTool,
): boolean {
  if (!tool.enabled) {
    return false;
  }
  if (!isMcpToolEnabledForServer(server, tool)) {
    return false;
  }
  if (binding.mode === "all_current_tools") {
    return true;
  }
  return binding.selectedToolNames.includes(tool.rawName);
}

function isMcpToolEnabledForServer(server: McpServer, tool: Pick<McpTool, "rawName" | "enabled">): boolean {
  if (!tool.enabled) {
    return false;
  }
  if (server.enabledTools && !server.enabledTools.includes(tool.rawName)) {
    return false;
  }
  return !server.disabledTools.includes(tool.rawName);
}

function hasLegacyMcpSecretConfig(server: McpServer): boolean {
  if (server.transport.type === "stdio") {
    return (server.transport.secretEnvNames ?? []).length > 0;
  }
  return (
    (server.transport.secretHeaderNames ?? []).length > 0 ||
    Object.keys(server.transport.envHeaders ?? {}).length > 0 ||
    Boolean(server.transport.bearerTokenEnvVar)
  );
}

function createMcpRunnerToolName(serverId: string, rawName: string): string {
  const stem = `${serverId}_${rawName}`.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 64);
  const hash = createHash("sha1").update(`${serverId}:${rawName}`).digest("hex").slice(0, 8);
  return `mcp_${stem}_${hash}`;
}
