import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer, McpStreamableHttpTransport, SecretPurpose, SecretResolver, SecretStatus } from "@ling-stack/core";
import { parseSecretRef } from "@ling-stack/core";
import type { McpProcessLauncher } from "./stdio-launcher.js";
import { createHostMcpFetch, type HostMcpOperation } from "./host-operation.js";
import { createHostMcpStdioTransport } from "./host-stdio-transport.js";

export class McpSecretResolutionError extends Error {
  readonly statuses: readonly SecretStatus[];

  constructor(statuses: readonly SecretStatus[]) {
    super(`Missing MCP secret refs: ${statuses.map((status) => status.ref).join(", ")}`);
    this.name = "McpSecretResolutionError";
    this.statuses = statuses;
  }
}

export interface ResolvedMcpTransport {
  readonly transport: McpTransport;
  readonly secretStatuses: readonly SecretStatus[];
  readonly resolvedSecretValues: readonly string[];
}

export function createMcpTransport(input: {
  readonly server: McpServer;
  readonly secretResolver: SecretResolver;
  readonly processLauncher: McpProcessLauncher;
  readonly hostOperation?: HostMcpOperation;
  readonly signal?: AbortSignal;
}): ResolvedMcpTransport {
  if (input.server.transport.type === "stdio") {
    const env: Record<string, string> = { ...input.server.transport.env };
    const resolution = resolveSecretRefs(input.secretResolver, input.server.transport.secretEnvRefs ?? {}, "automation_token");
    for (const [envName, value] of Object.entries(resolution.values)) {
      env[envName] = value;
    }
    const launch = {
        command: input.server.transport.command,
        args: input.server.transport.args,
        env,
        cwd: input.server.transport.cwd,
    };
    return {
      // Only the fixed native Host adapter receives the original capability.
      // A caller's processLauncher can never claim tracked effect support.
      transport: input.hostOperation
        ? createHostMcpStdioTransport({ launch, operation: input.hostOperation, signal: input.signal,
          sendTimeoutMs: (input.server.toolTimeoutSec ?? input.server.startupTimeoutSec ?? 30) * 1000 })
        : input.processLauncher.createStdioTransport(launch),
      secretStatuses: resolution.statuses,
      resolvedSecretValues: Object.values(resolution.values),
    };
  }

  const httpServer = input.server as McpServer & { readonly transport: McpStreamableHttpTransport };
  const { headers, statuses, values } = buildMcpHttpHeaders({
    transport: httpServer.transport,
    secretResolver: input.secretResolver,
  });
  return {
    transport: new StreamableHTTPClientTransport(new URL(httpServer.transport.url), {
      requestInit: { headers },
      ...(input.hostOperation ? { fetch: createHostMcpFetch(input.hostOperation) } : {}),
    }),
    secretStatuses: statuses,
    resolvedSecretValues: values,
  };
}

export function buildMcpHttpHeaders(input: {
  readonly transport: McpStreamableHttpTransport;
  readonly secretResolver: SecretResolver;
}): { readonly headers: Record<string, string>; readonly statuses: readonly SecretStatus[]; readonly values: readonly string[] } {
  const headers: Record<string, string> = { ...input.transport.headers };
  const statuses: SecretStatus[] = [];
  const values: string[] = [];

  const headerResolution = resolveSecretRefs(input.secretResolver, input.transport.secretHeaderRefs ?? {}, "custom_header");
  statuses.push(...headerResolution.statuses);
  for (const [headerName, value] of Object.entries(headerResolution.values)) {
    headers[headerName] = value;
    values.push(value);
  }

  if (input.transport.bearerTokenRef) {
    const resolved = input.secretResolver.resolve(input.transport.bearerTokenRef, "custom_header");
    if (resolved.status) {
      statuses.push(resolved.status);
    }
    if (!resolved.configured || !resolved.value) {
      throw new McpSecretResolutionError(resolved.status ? [resolved.status] : []);
    }
    if (headers.Authorization === undefined) {
      headers.Authorization = `Bearer ${resolved.value}`;
      values.push(resolved.value);
    }
  }

  for (const [headerName, envName] of Object.entries(input.transport.envHeaders ?? {})) {
    const resolved = input.secretResolver.resolve(`env:${envName}`, "custom_header");
    if (resolved.status) {
      statuses.push(resolved.status);
    }
    if (!resolved.configured || !resolved.value) {
      throw new McpSecretResolutionError(resolved.status ? [resolved.status] : []);
    }
    headers[headerName] = resolved.value;
    values.push(resolved.value);
  }

  if (input.transport.bearerTokenEnvVar) {
    const resolved = input.secretResolver.resolve(`env:${input.transport.bearerTokenEnvVar}`, "custom_header");
    if (resolved.status) {
      statuses.push(resolved.status);
    }
    if (!resolved.configured || !resolved.value) {
      throw new McpSecretResolutionError(resolved.status ? [resolved.status] : []);
    }
    if (headers.Authorization === undefined) {
      headers.Authorization = `Bearer ${resolved.value}`;
      values.push(resolved.value);
    }
  }

  return { headers, statuses, values };
}

function resolveSecretRefs(
  secretResolver: SecretResolver,
  refs: Readonly<Record<string, string>>,
  purpose: SecretPurpose,
): { readonly statuses: readonly SecretStatus[]; readonly values: Readonly<Record<string, string>> } {
  const statuses: SecretStatus[] = [];
  const values: Record<string, string> = {};
  const missing: SecretStatus[] = [];
  for (const [name, ref] of Object.entries(refs)) {
    const resolved = secretResolver.resolve(ref, purpose);
    const configured = resolved.configured === true && typeof resolved.value === "string" && resolved.value.length > 0;
    // Diagnostic status is optional; it cannot authorize a missing credential.
    // Derive absence from the resolution, retaining a truthful status for UI.
    const status: SecretStatus = {
      ...(resolved.status ?? { ref, kind: parseSecretRef(ref).kind, configured }),
      ref,
      configured,
      ...(!configured ? { errorCode: resolved.status?.errorCode ?? "secret_missing" } : {}),
    };
    statuses.push(status);
    if (!configured) {
      missing.push(status);
      continue;
    }
    values[name] = resolved.value!;
  }
  if (missing.length > 0) {
    throw new McpSecretResolutionError(missing);
  }
  return { statuses, values };
}
