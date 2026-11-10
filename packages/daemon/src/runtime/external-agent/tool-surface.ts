import type { RunnerToolExecutionConformanceV1 } from "../runner-tool-conformance.js";

export type ExternalToolSideEffect =
  | "none"
  | "workspace_read"
  | "workspace_write"
  | "shell"
  | "network"
  | "provider_or_secret"
  | "external_delivery";

export interface ExternalToolProposal {
  readonly backendToolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly sideEffect: ExternalToolSideEffect;
}

export interface ExternalToolSurfacePolicy {
  readonly adapterRevision: string;
  readonly receiptAdapterRevision: string;
  readonly requestedTools: readonly string[];
  readonly curatedTools: readonly string[];
  readonly toolSideEffects: Readonly<Record<string, ExternalToolSideEffect>>;
  readonly allowedSideEffects: readonly ExternalToolSideEffect[];
  readonly nativeSideEffectMode: RunnerToolExecutionConformanceV1["nativeSideEffectMode"];
  readonly approvalBridgeVerified: boolean;
  readonly sandboxBindingVerified: boolean;
  readonly evidenceCommitVerified: boolean;
  readonly abortPropagationVerified: boolean;
  readonly attemptFencingVerified: boolean;
  readonly workspaceBoundaryVerified: boolean;
  readonly artifactImportVerified: boolean;
  readonly mcpBridgeEnabled: boolean;
  readonly providerSecretAccess: "forbidden";
  readonly externalDelivery: "forbidden";
  readonly memoryMutation: "forbidden";
}

export function defaultExternalToolSurfacePolicy(
  requestedTools: readonly string[] = ["read", "grep", "find", "ls"],
): ExternalToolSurfacePolicy {
  return {
    adapterRevision: "external-read-only:test-v1",
    receiptAdapterRevision: "external-read-only:test-v1",
    requestedTools,
    curatedTools: ["read", "grep", "find", "ls"],
    toolSideEffects: {
      read: "workspace_read",
      grep: "workspace_read",
      find: "workspace_read",
      ls: "workspace_read",
    },
    allowedSideEffects: ["none", "workspace_read"],
    nativeSideEffectMode: "disabled",
    approvalBridgeVerified: false,
    sandboxBindingVerified: false,
    evidenceCommitVerified: true,
    abortPropagationVerified: true,
    attemptFencingVerified: true,
    workspaceBoundaryVerified: true,
    artifactImportVerified: true,
    mcpBridgeEnabled: false,
    providerSecretAccess: "forbidden",
    externalDelivery: "forbidden",
    memoryMutation: "forbidden",
  };
}

export function externalToolSurfacePolicyFromConformance(
  adapterRevision: string,
  receipt: RunnerToolExecutionConformanceV1 | undefined,
  requestedTools: readonly string[],
): ExternalToolSurfacePolicy {
  if (!receipt) {
    throw new Error("External runner tool conformance receipt is missing.");
  }
  return {
    adapterRevision,
    receiptAdapterRevision: receipt.adapterRevision,
    requestedTools,
    curatedTools: receipt.curatedTools,
    toolSideEffects: receipt.toolSideEffects,
    allowedSideEffects: receipt.allowedSideEffects,
    nativeSideEffectMode: receipt.nativeSideEffectMode,
    approvalBridgeVerified: receipt.approvalBridgeVerified,
    sandboxBindingVerified: receipt.sandboxBindingVerified,
    evidenceCommitVerified: receipt.evidenceCommitVerified,
    abortPropagationVerified: receipt.abortPropagationVerified,
    attemptFencingVerified: receipt.attemptFencingVerified,
    workspaceBoundaryVerified: receipt.workspaceBoundaryVerified,
    artifactImportVerified: receipt.artifactImportVerified,
    mcpBridgeEnabled: false,
    providerSecretAccess: "forbidden",
    externalDelivery: "forbidden",
    memoryMutation: "forbidden",
  };
}

export function assertExternalToolAllowed(
  proposal: ExternalToolProposal,
  policy: ExternalToolSurfacePolicy = defaultExternalToolSurfacePolicy(),
): void {
  if (!proposal.backendToolCallId || !proposal.toolName) {
    throw new Error("External tool proposal requires backendToolCallId and toolName.");
  }
  if (policy.adapterRevision !== policy.receiptAdapterRevision) {
    throw new Error("External runner tool conformance revision does not match the active adapter.");
  }
  if (!policy.requestedTools.includes(proposal.toolName)) {
    throw new Error(`External tool was not requested for this run: ${proposal.toolName}`);
  }
  if (!policy.curatedTools.includes(proposal.toolName)) {
    throw new Error(`External tool is not part of the curated surface: ${proposal.toolName}`);
  }
  const expectedSideEffect = policy.toolSideEffects[proposal.toolName];
  if (!expectedSideEffect) {
    throw new Error(`External tool has no verified side-effect classification: ${proposal.toolName}`);
  }
  if (expectedSideEffect !== proposal.sideEffect) {
    throw new Error(`External tool side-effect classification mismatch: ${proposal.toolName}`);
  }
  if (!policy.allowedSideEffects.includes(proposal.sideEffect)) {
    throw new Error(`External tool side effect is not enabled: ${proposal.sideEffect}`);
  }
  if (proposal.sideEffect === "provider_or_secret") {
    throw new Error("External agents may not access provider secrets.");
  }
  if (proposal.sideEffect === "external_delivery") {
    throw new Error("External delivery stays owned by Ling.");
  }
  if (!policy.evidenceCommitVerified || !policy.abortPropagationVerified || !policy.attemptFencingVerified) {
    throw new Error("External runner tool evidence, cancellation, or Attempt fencing is not verified.");
  }
  if (
    (proposal.sideEffect === "workspace_read" || proposal.sideEffect === "workspace_write" || proposal.sideEffect === "shell") &&
    !policy.workspaceBoundaryVerified
  ) {
    throw new Error("External runner workspace boundary is not verified.");
  }
  if (proposal.sideEffect !== "none" && proposal.sideEffect !== "workspace_read") {
    if (policy.nativeSideEffectMode === "disabled") {
      throw new Error("External runner native side effects are disabled.");
    }
    if (policy.nativeSideEffectMode !== "daemon_brokered") {
      throw new Error("External runner native side-effect mode is unverified.");
    }
    if (!policy.approvalBridgeVerified || !policy.sandboxBindingVerified) {
      throw new Error("External runner approval or sandbox binding is not verified.");
    }
  }
}

export function assertExternalArtifactImportAllowed(policy: ExternalToolSurfacePolicy): void {
  if (policy.adapterRevision !== policy.receiptAdapterRevision) {
    throw new Error("External runner artifact conformance revision does not match the active adapter.");
  }
  if (!policy.artifactImportVerified) {
    throw new Error("External runner artifact import is not verified.");
  }
}
