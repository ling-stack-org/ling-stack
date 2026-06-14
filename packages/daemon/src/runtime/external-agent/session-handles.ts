export type ExternalAgentBackend = "codex-app-server" | "openclaw-acp" | "custom";

export interface ExternalAgentSessionHandle {
  readonly runnerId: string;
  readonly backend: ExternalAgentBackend;
  readonly backendSessionId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export function createExternalAgentSessionHandle(input: {
  readonly runnerId: string;
  readonly backend: ExternalAgentBackend;
  readonly backendSessionId: string;
  readonly now?: string;
  readonly expiresAt?: string;
  readonly metadata?: Record<string, unknown>;
}): ExternalAgentSessionHandle {
  if (!input.runnerId || !input.backendSessionId) {
    throw new Error("External agent session handles require runnerId and backendSessionId.");
  }
  return {
    runnerId: input.runnerId,
    backend: input.backend,
    backendSessionId: input.backendSessionId,
    createdAt: input.now ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
    metadata: input.metadata,
  };
}
