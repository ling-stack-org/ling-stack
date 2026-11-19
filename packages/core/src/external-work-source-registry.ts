import { createGitHubExternalWorkAdapter, createLinearExternalWorkAdapter } from "./external-work-source-adapters.js";
import { ExternalWorkflowValidationError, normalizeGitHubExternalWorkItem, normalizeLinearExternalWorkItem } from "./external-work.js";
import type {
  ExternalSourceKind,
  ExternalSourceTarget,
  ExternalWorkFetchLike,
  ExternalWorkItem,
  ExternalWorkItemKind,
  ExternalWorkSourceAdapter,
  ExternalWorkflowDefinition,
  ExternalWorkflowSourceConfig,
} from "./external-work-types.js";

export type ExternalSecretPurpose = "github_token" | "linear_token";

export interface ExternalSourceAdapterOptions {
  readonly fetch?: ExternalWorkFetchLike;
}

export interface ExternalSourceImportInput {
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowDefinition: ExternalWorkflowDefinition;
}

export interface ExternalSourceRegistration {
  readonly kind: ExternalSourceKind;
  readonly displayName: string;
  readonly workItemKinds: readonly ExternalWorkItemKind[];
  readonly secretPurpose: ExternalSecretPurpose;
  readonly supportsRemoteTerminalReconcile: boolean;
  resolveTarget(config: ExternalWorkflowSourceConfig): ExternalSourceTarget;
  sourceKey(target: ExternalSourceTarget): string;
  createAdapter(options?: ExternalSourceAdapterOptions): ExternalWorkSourceAdapter;
  normalizeImport(input: ExternalSourceImportInput): ExternalWorkItem;
}

const registrations: Readonly<Record<ExternalSourceKind, ExternalSourceRegistration>> = Object.freeze({
  github: Object.freeze({
    kind: "github",
    displayName: "GitHub",
    workItemKinds: Object.freeze(["github_pull_request", "github_issue"] as const),
    secretPurpose: "github_token",
    supportsRemoteTerminalReconcile: true,
    resolveTarget(config: ExternalWorkflowSourceConfig) {
      return resolveTarget(config, "github", config.repository, "repository");
    },
    sourceKey(target: ExternalSourceTarget) { return sourceKey(target, "github"); },
    createAdapter: createGitHubExternalWorkAdapter,
    normalizeImport(input: ExternalSourceImportInput) {
      const target = registrations.github.resolveTarget(input.workflowDefinition.config.source);
      return normalizeGitHubExternalWorkItem({ eventType: input.eventType, payload: input.payload, repositoryFullName: target.id });
    },
  }),
  linear: Object.freeze({
    kind: "linear",
    displayName: "Linear",
    workItemKinds: Object.freeze(["linear_issue"] as const),
    secretPurpose: "linear_token",
    supportsRemoteTerminalReconcile: false,
    resolveTarget(config: ExternalWorkflowSourceConfig) {
      return resolveTarget(config, "linear", config.projectSlug, "projectSlug");
    },
    sourceKey(target: ExternalSourceTarget) { return sourceKey(target, "linear"); },
    createAdapter: createLinearExternalWorkAdapter,
    normalizeImport(input: ExternalSourceImportInput) {
      const target = registrations.linear.resolveTarget(input.workflowDefinition.config.source);
      return normalizeLinearExternalWorkItem({ eventType: input.eventType, payload: input.payload, projectSlug: target.id });
    },
  }),
});

/** Fixed provider metadata; lookup never creates an adapter or performs IO. */
export function getExternalSourceRegistration(kind: string): ExternalSourceRegistration {
  if (!Object.hasOwn(registrations, kind)) {
    throw new ExternalWorkflowValidationError(`Unsupported external source kind: ${kind}`);
  }
  return registrations[kind as ExternalSourceKind];
}

export function externalWorkSecretPurposeForSource(kind: ExternalSourceKind): ExternalSecretPurpose {
  return getExternalSourceRegistration(kind).secretPurpose;
}

function resolveTarget(
  config: ExternalWorkflowSourceConfig, kind: ExternalSourceKind, id: string | undefined, field: string,
): ExternalSourceTarget {
  assertKind(config.kind, kind);
  if (!id) throw new ExternalWorkflowValidationError(`WORKFLOW.md source.${field} is required.`);
  return Object.freeze({ kind, id, label: id });
}

function sourceKey(target: ExternalSourceTarget, kind: ExternalSourceKind): string {
  assertKind(target.kind, kind);
  return `${kind}:${target.id}`;
}

function assertKind(actual: ExternalSourceKind, expected: ExternalSourceKind): void {
  if (actual !== expected) throw new ExternalWorkflowValidationError(`Unsupported external source kind: ${actual}`);
}
