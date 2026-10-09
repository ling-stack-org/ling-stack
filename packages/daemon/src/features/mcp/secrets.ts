import type { McpRuntimeStatusSnapshot, McpServer, McpStoreFacet, PublicMcpServer, SecretPurpose, SecretResolver, SecretStatus } from "@ling-stack/core";
import { deriveMcpServerStatus } from "./status.js";

export interface McpTransportSecretRef {
  readonly destination: string;
  readonly ref: string;
  readonly purpose: SecretPurpose;
}

export function toPublicMcpServer(input: {
  readonly store: McpStoreFacet;
  readonly server: McpServer;
  readonly secretResolver: SecretResolver;
  readonly now: string;
  /** Mutation receipts must project the same committed snapshot at both response levels. */
  readonly committedStatusSnapshot?: McpRuntimeStatusSnapshot;
}): PublicMcpServer {
  const refs = mcpServerSecretRefs(input.server);
  const secretStatuses = refs.map((item) => input.secretResolver.status(item.ref, item.purpose));
  const secretConfigured: Record<string, boolean> = {};
  for (const [index, ref] of refs.entries()) {
    secretConfigured[ref.destination] = secretStatuses[index]?.configured === true;
  }
  const legacySecretNames = input.store.listLegacyMcpServerSecretNames(input.server.id);
  for (const secretName of legacySecretNames) {
    secretConfigured[secretName] = false;
  }
  const statusSnapshot = input.committedStatusSnapshot ?? input.store.getMcpStatusSnapshot(input.server.id, input.now);
  return {
    ...input.server,
    status: deriveMcpServerStatus(statusSnapshot, input.server.status),
    statusSnapshot,
    secretConfigured,
    secretStatuses,
    legacySecretMigrationRequired: legacySecretNames.length > 0 || hasLegacySecretConfig(input.server),
  };
}

export function mcpServerSecretRefs(server: McpServer): readonly McpTransportSecretRef[] {
  if (server.transport.type === "stdio") {
    return Object.entries(server.transport.secretEnvRefs ?? {}).map(([destination, ref]) => ({
      destination,
      ref,
      purpose: "automation_token",
    }));
  }

  const refs: McpTransportSecretRef[] = Object.entries(server.transport.secretHeaderRefs ?? {}).map(([destination, ref]) => ({
    destination,
    ref,
    purpose: "custom_header",
  }));
  if (server.transport.bearerTokenRef) {
    refs.push({
      destination: "Authorization",
      ref: server.transport.bearerTokenRef,
      purpose: "custom_header",
    });
  }
  for (const [destination, envName] of Object.entries(server.transport.envHeaders ?? {})) {
    refs.push({
      destination,
      ref: `env:${envName}`,
      purpose: "custom_header",
    });
  }
  if (server.transport.bearerTokenEnvVar) {
    refs.push({
      destination: "Authorization",
      ref: `env:${server.transport.bearerTokenEnvVar}`,
      purpose: "custom_header",
    });
  }
  return refs;
}

export function mcpServerSecretStatuses(server: McpServer, secretResolver: SecretResolver): readonly SecretStatus[] {
  return mcpServerSecretRefs(server).map((item) => secretResolver.status(item.ref, item.purpose));
}

export function mcpServerSecretNames(server: McpServer): readonly string[] {
  if (server.transport.type === "stdio") {
    return [
      ...Object.keys(server.transport.secretEnvRefs ?? {}),
      ...(server.transport.secretEnvNames ?? []),
    ];
  }
  return [
    ...Object.keys(server.transport.secretHeaderRefs ?? {}),
    ...(server.transport.bearerTokenRef ? ["Authorization"] : []),
    ...Object.keys(server.transport.envHeaders ?? {}),
    ...(server.transport.bearerTokenEnvVar ? ["Authorization"] : []),
    ...(server.transport.secretHeaderNames ?? []),
  ];
}

function hasLegacySecretConfig(server: McpServer): boolean {
  if (server.transport.type === "stdio") {
    return (server.transport.secretEnvNames ?? []).length > 0;
  }
  return (
    (server.transport.secretHeaderNames ?? []).length > 0 ||
    Object.keys(server.transport.envHeaders ?? {}).length > 0 ||
    Boolean(server.transport.bearerTokenEnvVar)
  );
}
