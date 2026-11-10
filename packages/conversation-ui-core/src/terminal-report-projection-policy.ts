import { getConversationInteractionPolicy, type ConversationInteractionSurfaceKind } from "./surface-policy.js";

export type TerminalReportArtifactMode = "inline" | "compact" | "detail";

export interface TerminalReportProjectionPolicy {
  readonly showParticipants: boolean;
  readonly showReferences: boolean;
  readonly artifactMode: TerminalReportArtifactMode;
}

export function getTerminalReportProjectionPolicy(
  surface: ConversationInteractionSurfaceKind,
  override?: Partial<TerminalReportProjectionPolicy>,
): TerminalReportProjectionPolicy {
  const surfacePolicy = getConversationInteractionPolicy(surface);
  return {
    showParticipants: surfacePolicy.showTerminalReportParticipants,
    showReferences: true,
    artifactMode: surface === "run_thread" ? "detail" : "compact",
    ...override,
  };
}
