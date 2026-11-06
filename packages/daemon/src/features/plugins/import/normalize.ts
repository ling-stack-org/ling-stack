import { createHash } from "node:crypto";
import type { McpServer, McpServerTransport } from "@ling-stack/core";
import type { PluginImportSource } from "./sources.js";
import type { ImportSecretFinding, StrippedImportTransport } from "./secret-policy.js";

export interface ImportCandidate {
  readonly kind: "mcp";
  readonly source: PluginImportSource;
  readonly name: string;
  readonly displayName: string;
  readonly transport: StrippedImportTransport;
  readonly fingerprint: string;
  readonly findings: readonly ImportSecretFinding[];
  readonly warnings: readonly string[];
}

export type ImportCandidateStatus = "new" | "unchanged" | "conflict";

export interface ImportCandidateView extends ImportCandidate {
  readonly status: ImportCandidateStatus;
}

/**
 * Fingerprint covers the transport semantics only: no secret refs, no display names.
 * Two servers whose transports behave identically are the same server regardless of
 * which ecosystem's config they were read from.
 */
export function fingerprintImportTransport(transport: StrippedImportTransport): string {
  const canonical = transport.type === "stdio"
    ? {
        type: "stdio",
        command: transport.command,
        args: [...transport.args],
        env: sortedEntries(transport.env),
        cwd: transport.cwd ?? null,
      }
    : {
        type: "http",
        url: transport.url,
        headers: sortedEntries(transport.headers),
      };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function existingServerFingerprint(transport: McpServerTransport): string {
  return fingerprintImportTransport(toStrippedTransport(transport));
}

export function toStrippedTransport(transport: McpServerTransport): StrippedImportTransport {
  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: transport.command,
      args: transport.args,
      env: transport.env,
      cwd: transport.cwd,
      secretEnvRefs: transport.secretEnvRefs,
    };
  }
  return {
    type: "streamable-http",
    url: transport.url,
    headers: transport.headers,
    secretHeaderRefs: transport.secretHeaderRefs,
  };
}

export function classifyImportCandidate(
  candidate: ImportCandidate,
  existingServers: readonly McpServer[],
): ImportCandidateView {
  const fingerprintExists = existingServers.some((server) => existingServerFingerprint(server.transport) === candidate.fingerprint);
  if (fingerprintExists) {
    return { ...candidate, status: "unchanged" };
  }
  const nameExists = existingServers.some((server) => server.displayName.trim().toLowerCase() === candidate.displayName.trim().toLowerCase());
  if (nameExists) {
    return { ...candidate, status: "conflict" };
  }
  return { ...candidate, status: "new" };
}

export function importedDisplayName(candidate: ImportCandidateView): string {
  if (candidate.status !== "conflict") {
    return candidate.displayName;
  }
  return `${candidate.displayName}（来自 ${importSourceLabel(candidate.source)}）`;
}

export function importSourceLabel(source: PluginImportSource): string {
  switch (source) {
    case "codex-config-toml":
      return "Codex";
    case "claude-user-json":
      return "Claude";
    case "claude-plugin-mcp":
      return "Claude 插件";
    case "dsh-cordis-patch":
      return "dsh";
    case "claude-commands":
      return "Claude 命令";
  }
}

function sortedEntries(record: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key];
  }
  return out;
}
