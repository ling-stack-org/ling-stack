import type { ManagedPluginHealthSnapshot, McpServerTransport, SecretResolver, SecretPurpose } from "@ling-stack/core";
import type { RunStoreRegistry } from "../../../runtime/store-registry.js";
import type { McpBroker } from "../../../context.js";
import type { ExternalSecretStore } from "../../../context.js";
import { createTrustedLocalMcpPlugin } from "../create-local-plugin.js";
import { pluginHealthFromMcpSnapshot } from "../cua-driver-activation.js";
import { listEffectiveSkillRegistryEntries } from "../../skills/registry.js";
import { parseSkillImportDraftRequest } from "../../skills/schemas.js";
import { scanPluginImportSource, rewriteCommandInlineExecutions, type PluginImportSource, type RawImportCandidate } from "./sources.js";
import { applySecretPolicyToHttp, applySecretPolicyToStdio, type PendingImportSecret, type StrippedImportTransport } from "./secret-policy.js";
import { classifyImportCandidate, fingerprintImportTransport, importedDisplayName, type ImportCandidate } from "./normalize.js";
import {
  toCandidateReport,
  type ImportedMcpReportEntry,
  type ImportedReportEntry,
  type ImportCandidatePreview,
  type PluginImportApplyReport,
  type PluginImportPreviewReport,
  type SkippedReportEntry,
} from "./report.js";

type PluginStore = ReturnType<RunStoreRegistry["getStore"]>;

const IMPORT_EVENT_ACTOR = "local-user";
const IMPORT_SECRET_PURPOSE: SecretPurpose = "custom_header";

export function buildPluginImportPreview(input: {
  readonly store: PluginStore;
  readonly source: PluginImportSource;
  readonly homeDir?: string;
}): PluginImportPreviewReport {
  const scan = scanPluginImportSource(input.source, { homeDir: input.homeDir });
  const candidates: ImportCandidatePreview[] = [];
  const warnings = [...scan.warnings];
  if (input.source === "claude-commands") {
    const skillEntries = listEffectiveSkillRegistryEntries(input.store);
    const knownSkillIds = new Set(skillEntries.map((skill) => skill.id));
    for (const candidate of scan.candidates) {
      if (candidate.kind !== "command") {
        continue;
      }
      const skillId = commandSkillId(candidate.content, candidate.name, skillEntries);
      const imported = knownSkillIds.has(skillId) || input.store.getSkillImportDraft(commandImportDraftId(skillId)) !== undefined;
      candidates.push({
        kind: "command",
        source: candidate.source,
        name: candidate.name,
        displayName: candidate.displayName,
        status: imported ? "unchanged" : "new",
        inlineExecutions: candidate.inlineExecutions,
        warnings: [],
      });
    }
    return { source: input.source, sourceFound: scan.sourceFound, candidates, warnings };
  }
  const existingServers = input.store.listMcpServers();
  for (const candidate of scan.candidates) {
    if (candidate.kind !== "mcp") {
      continue;
    }
    const policy = stripCandidateSecrets(candidate);
    const normalized: ImportCandidate = {
      kind: "mcp",
      source: candidate.source,
      name: candidate.name,
      displayName: candidate.displayName,
      transport: policy.transport,
      fingerprint: fingerprintImportTransport(policy.transport),
      findings: policy.findings,
      warnings: [],
    };
    const classified = classifyImportCandidate(normalized, existingServers);
    candidates.push(toCandidateReport({
      source: classified.source,
      name: classified.name,
      displayName: importedDisplayName(classified),
      transport: classified.transport,
      status: classified.status,
      findings: classified.findings,
      warnings: classified.warnings,
    }));
  }
  return { source: input.source, sourceFound: scan.sourceFound, candidates, warnings };
}

export async function applyPluginImport(input: {
  readonly store: PluginStore;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly externalSecretStore?: ExternalSecretStore;
  readonly source: PluginImportSource;
  readonly names: readonly string[];
  readonly homeDir?: string;
  readonly now: string;
}): Promise<PluginImportApplyReport> {
  const scan = scanPluginImportSource(input.source, { homeDir: input.homeDir });
  const warnings = [...scan.warnings];
  const selectedNames = new Set(input.names);
  const imported: ImportedReportEntry[] = [];
  const skipped: SkippedReportEntry[] = [];
  const degradations: string[] = [];
  let secretsMigrated = 0;
  let secretsNeedsInput = 0;

  if (input.source === "claude-commands") {
    const skillEntries = listEffectiveSkillRegistryEntries(input.store);
    for (const candidate of scan.candidates) {
      if (candidate.kind !== "command") {
        continue;
      }
      if (!selectedNames.has(candidate.name)) {
        continue;
      }
      const skillId = commandSkillId(candidate.content, candidate.name, skillEntries);
      const draftId = commandImportDraftId(skillId);
      if (skillEntries.some((skill) => skill.id === skillId) || input.store.getSkillImportDraft(draftId)) {
        skipped.push({ name: candidate.name, reason: "unchanged" });
        continue;
      }
      if (candidate.inlineExecutions.length > 0) {
        degradations.push(
          `${candidate.name}: ${candidate.inlineExecutions.length} inline execution(s) converted to bash-tool instructions (${candidate.inlineExecutions.join(", ")}); Ling does not execute them at import time`,
        );
      }
      const content = rewriteCommandInlineExecutions(candidate.content);
      const draftInput = parseSkillImportDraftRequest({
        content,
        sourcePath: `${candidate.name}.md`,
        name: candidate.name,
      }, skillEntries);
      const draft = input.store.createSkillImportDraft({ ...draftInput, id: draftId }, input.now);
      const firstDefinition = draft.definitions[0];
      imported.push({
        name: candidate.name,
        draftId: draft.id,
        skillId: firstDefinition?.definition.id ?? skillId,
      });
    }
    return {
      source: input.source,
      imported,
      skipped,
      secretsMigrated,
      secretsNeedsInput,
      degradations,
      warnings,
    };
  }

  const existingServers = input.store.listMcpServers();
  for (const candidate of scan.candidates) {
    if (candidate.kind !== "mcp" || !selectedNames.has(candidate.name)) {
      continue;
    }
    const policy = stripCandidateSecrets(candidate);
    const normalized: ImportCandidate = {
      kind: "mcp",
      source: candidate.source,
      name: candidate.name,
      displayName: candidate.displayName,
      transport: policy.transport,
      fingerprint: fingerprintImportTransport(policy.transport),
      findings: policy.findings,
      warnings: [],
    };
    const classified = classifyImportCandidate(normalized, existingServers);
    if (classified.status === "unchanged") {
      skipped.push({ name: candidate.name, reason: "unchanged" });
      continue;
    }
    const stored = storePendingSecrets(input.externalSecretStore, policy.pendingSecrets);
    secretsMigrated += stored.migrated;
    secretsNeedsInput += stored.needsInput;
    const transport = withStoredSecretRefs(policy.transport, stored.refs);
    const displayName = importedDisplayName(classified);
    const created = createTrustedLocalMcpPlugin({
      store: input.store,
      displayName,
      description: `Imported from ${candidate.source} (${candidate.name}).`,
      transport: toMcpServerTransport(transport),
      now: input.now,
    });
    input.store.appendManagedPluginEvent({
      pluginId: created.pluginId,
      type: "installed",
      actor: IMPORT_EVENT_ACTOR,
      message: `Imported ${candidate.name} from ${candidate.source}`,
      data: { source: candidate.source, name: candidate.name, fingerprint: classified.fingerprint },
    }, input.now);
    const check = await checkImportedServer({
      store: input.store,
      mcpBroker: input.mcpBroker,
      secretResolver: input.secretResolver,
      mcpServerId: created.mcpServerId,
      pluginId: created.pluginId,
      now: input.now,
    });
    imported.push({
      name: candidate.name,
      pluginId: created.pluginId,
      mcpServerId: created.mcpServerId,
      check: check.status,
      checkMessage: check.message,
    });
  }
  return {
    source: input.source,
    imported,
    skipped,
    secretsMigrated,
    secretsNeedsInput,
    degradations,
    warnings,
  };
}

async function checkImportedServer(input: {
  readonly store: PluginStore;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly mcpServerId: string;
  readonly pluginId: string;
  readonly now: string;
}): Promise<{ readonly status: "ready" | "failed" | "unknown"; readonly message?: string }> {
  const server = input.store.getMcpServer(input.mcpServerId);
  if (!server) {
    return { status: "unknown", message: "Imported MCP server record is missing." };
  }
  try {
    const result = await input.mcpBroker.checkServer(server, {
      secretResolver: input.secretResolver,
      now: () => input.now,
    });
    const snapshot = input.store.upsertMcpStatusSnapshot(result.statusSnapshot, input.now);
    const health: ManagedPluginHealthSnapshot = pluginHealthFromMcpSnapshot(input.pluginId, snapshot);
    input.store.upsertManagedPluginHealthSnapshot(health, input.now);
    input.store.appendManagedPluginEvent({
      pluginId: input.pluginId,
      type: "checked",
      actor: IMPORT_EVENT_ACTOR,
      message: health.message,
      data: { status: health.status },
    }, input.now);
    return { status: snapshot.status === "ready" ? "ready" : "failed", message: snapshot.message };
  } catch (error) {
    return { status: "unknown", message: error instanceof Error ? error.message : String(error) };
  }
}

function storePendingSecrets(
  externalSecretStore: ExternalSecretStore | undefined,
  pendingSecrets: readonly PendingImportSecret[],
): { readonly migrated: number; readonly needsInput: number; readonly refs: Readonly<Record<string, boolean>> } {
  const refs: Record<string, boolean> = {};
  let migrated = 0;
  let needsInput = 0;
  for (const secret of pendingSecrets) {
    const stored = tryStoreSecret(externalSecretStore, secret);
    if (stored) {
      refs[secret.refName] = true;
      migrated += 1;
    } else {
      needsInput += 1;
    }
  }
  return { migrated, needsInput, refs };
}

function tryStoreSecret(externalSecretStore: ExternalSecretStore | undefined, secret: PendingImportSecret): boolean {
  if (!externalSecretStore) {
    return false;
  }
  try {
    const status = externalSecretStore.setSecret(`keychain:${secret.refName}`, secret.value, IMPORT_SECRET_PURPOSE);
    return status.configured;
  } catch {
    return false;
  }
}

function withStoredSecretRefs(transport: StrippedImportTransport, storedRefs: Readonly<Record<string, boolean>>): StrippedImportTransport {
  const keepRef = (ref: string): boolean => {
    const refName = ref.startsWith("keychain:") ? ref.slice("keychain:".length) : ref;
    return storedRefs[refName] === true;
  };
  if (transport.type === "stdio") {
    const secretEnvRefs: Record<string, string> = {};
    for (const [field, ref] of Object.entries(transport.secretEnvRefs)) {
      if (keepRef(ref)) {
        secretEnvRefs[field] = ref;
      }
    }
    return { ...transport, secretEnvRefs };
  }
  const secretHeaderRefs: Record<string, string> = {};
  for (const [field, ref] of Object.entries(transport.secretHeaderRefs)) {
    if (keepRef(ref)) {
      secretHeaderRefs[field] = ref;
    }
  }
  return { ...transport, secretHeaderRefs };
}

function stripCandidateSecrets(candidate: Extract<RawImportCandidate, { kind: "mcp" }>) {
  return candidate.transport.type === "stdio"
    ? applySecretPolicyToStdio({
        source: candidate.source,
        serverName: candidate.name,
        command: candidate.transport.command,
        args: candidate.transport.args,
        env: candidate.transport.env,
        cwd: candidate.transport.cwd,
      })
    : applySecretPolicyToHttp({
        source: candidate.source,
        serverName: candidate.name,
        url: candidate.transport.url,
        headers: candidate.transport.headers,
      });
}

function toMcpServerTransport(transport: StrippedImportTransport): McpServerTransport {
  return transport.type === "stdio"
    ? {
        type: "stdio",
        command: transport.command,
        args: transport.args,
        env: transport.env,
        cwd: transport.cwd,
        secretEnvRefs: transport.secretEnvRefs,
      }
    : {
        type: "streamable-http",
        url: transport.url,
        headers: transport.headers,
        secretHeaderRefs: transport.secretHeaderRefs,
      };
}

function commandImportDraftId(skillId: string): string {
  return `skill_draft_import-command-${skillId}`;
}

function commandSkillId(
  content: string,
  name: string,
  skillEntries: readonly ReturnType<typeof listEffectiveSkillRegistryEntries>[number][],
): string {
  const draftInput = parseSkillImportDraftRequest({ content, sourcePath: `${name}.md`, name }, skillEntries);
  const definition = draftInput.definitions[0];
  return definition?.definition.id ?? name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
