import type { PluginImportSource } from "./sources.js";
import type { ImportSecretFinding } from "./secret-policy.js";
import type { ImportCandidateStatus } from "./normalize.js";
import type { StrippedImportTransport } from "./secret-policy.js";

export interface ImportCandidateSecretView {
  readonly field: string;
  readonly masked: string;
  readonly needsInput: boolean;
}

export interface ImportCandidateReport {
  readonly kind: "mcp";
  readonly source: PluginImportSource;
  readonly name: string;
  readonly displayName: string;
  readonly transportSummary: string;
  readonly status: ImportCandidateStatus;
  readonly secrets: readonly ImportCandidateSecretView[];
  readonly warnings: readonly string[];
}

export interface ImportCommandReport {
  readonly kind: "command";
  readonly source: PluginImportSource;
  readonly name: string;
  readonly displayName: string;
  readonly status: ImportCandidateStatus;
  readonly inlineExecutions: readonly string[];
  readonly warnings: readonly string[];
}

export type ImportCandidatePreview = ImportCandidateReport | ImportCommandReport;

export interface PluginImportPreviewReport {
  readonly source: PluginImportSource;
  readonly sourceFound: boolean;
  readonly candidates: readonly ImportCandidatePreview[];
  readonly warnings: readonly string[];
}

export interface ImportedMcpReportEntry {
  readonly name: string;
  readonly pluginId: string;
  readonly mcpServerId: string;
  readonly check: "ready" | "failed" | "unknown";
  readonly checkMessage?: string;
}

export interface ImportedCommandReportEntry {
  readonly name: string;
  readonly draftId: string;
  readonly skillId: string;
}

export type ImportedReportEntry = ImportedMcpReportEntry | ImportedCommandReportEntry;

export interface SkippedReportEntry {
  readonly name: string;
  readonly reason: "unchanged" | "unknown_name";
}

export interface PluginImportApplyReport {
  readonly source: PluginImportSource;
  readonly imported: readonly ImportedReportEntry[];
  readonly skipped: readonly SkippedReportEntry[];
  readonly secretsMigrated: number;
  readonly secretsNeedsInput: number;
  readonly degradations: readonly string[];
  readonly warnings: readonly string[];
}

export function summarizeImportTransport(transport: StrippedImportTransport): string {
  if (transport.type === "stdio") {
    return [transport.command, ...transport.args].join(" ");
  }
  return transport.url;
}

export function toCandidateReport(input: {
  readonly source: PluginImportSource;
  readonly name: string;
  readonly displayName: string;
  readonly transport: StrippedImportTransport;
  readonly status: ImportCandidateStatus;
  readonly findings: readonly ImportSecretFinding[];
  readonly warnings: readonly string[];
}): ImportCandidateReport {
  return {
    kind: "mcp",
    source: input.source,
    name: input.name,
    displayName: input.displayName,
    transportSummary: summarizeImportTransport(input.transport),
    status: input.status,
    secrets: input.findings.map((finding) => ({ field: finding.field, masked: finding.masked, needsInput: finding.needsInput })),
    warnings: input.warnings,
  };
}
