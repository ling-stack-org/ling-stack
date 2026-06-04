import type { McpServer, McpStreamableHttpTransport, RunStore } from "@ling-stack/core";

export function toPublicMcpServer(
  store: RunStore,
  server: McpServer,
): McpServer & { readonly secretConfigured: Readonly<Record<string, boolean>> } {
  const secretConfigured: Record<string, boolean> = {};
  for (const secretName of mcpServerSecretNames(server)) {
    secretConfigured[secretName] = store.hasMcpServerSecret(server.id, secretName);
  }
  return {
    ...server,
    secretConfigured,
  };
}

export function collectMcpServerSecrets(store: RunStore, server: McpServer): Readonly<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const secretName of mcpServerSecretNames(server)) {
    const secret = store.getMcpServerSecret(server.id, secretName);
    if (secret !== undefined) {
      secrets[secretName] = secret;
    }
  }
  return secrets;
}

export function mcpServerSecretNames(server: McpServer): readonly string[] {
  if (server.transport.type === "stdio") {
    return server.transport.secretEnvNames;
  }
  return server.transport.secretHeaderNames;
}
