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
  readonly allowedSideEffects: readonly ExternalToolSideEffect[];
  readonly mcpBridgeEnabled: boolean;
  readonly providerSecretAccess: "forbidden";
  readonly externalDelivery: "forbidden";
  readonly memoryMutation: "forbidden";
}

export function defaultExternalToolSurfacePolicy(): ExternalToolSurfacePolicy {
  return {
    allowedSideEffects: ["none", "workspace_read"],
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
  if (!policy.allowedSideEffects.includes(proposal.sideEffect)) {
    throw new Error(`External tool side effect is not enabled: ${proposal.sideEffect}`);
  }
  if (proposal.sideEffect === "provider_or_secret") {
    throw new Error("External agents may not access provider secrets.");
  }
  if (proposal.sideEffect === "external_delivery") {
    throw new Error("External delivery stays owned by Ling.");
  }
}
