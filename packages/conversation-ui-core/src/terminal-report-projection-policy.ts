import { getConversationSurfacePolicy, type ConversationSurfaceKind } from "./surface-policy.js";

export type TerminalReportArtifactMode = "inline" | "compact" | "detail";

export interface TerminalReportProjectionPolicy {
  readonly showParticipants: boolean;
  readonly showReferences: boolean;
  readonly artifactMode: TerminalReportArtifactMode;
}

export function getTerminalReportProjectionPolicy(
  surface: ConversationSurfaceKind,
  override?: Partial<TerminalReportProjectionPolicy>,
): TerminalReportProjectionPolicy {
  const surfacePolicy = getConversationSurfacePolicy(surface);
  return {
    showParticipants: surfacePolicy.showTerminalReportParticipants,
    showReferences: true,
    artifactMode: surface === "run_thread" ? "detail" : "compact",
    ...override,
  };
}
