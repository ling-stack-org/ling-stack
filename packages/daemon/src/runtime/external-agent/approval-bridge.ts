import type { RunTool } from "@ling-stack/core";
import type { ExternalToolProposal } from "./tool-surface.js";

export interface ExternalApprovalDecision {
  readonly approved: boolean;
  readonly approvalId?: string;
}

export interface ExternalApprovalBridgeRequest {
  readonly toolCallId: string;
  readonly toolName: RunTool | string;
  readonly input: unknown;
  readonly defaultApproval: "allow" | "ask" | "deny";
}

export interface ExternalApprovalBridgeOptions {
  readonly approvalBridgeVerified: boolean;
  readonly onApprovalRequired?: (request: ExternalApprovalBridgeRequest) => Promise<ExternalApprovalDecision>;
}

export async function bridgeExternalToolApproval(
  proposal: ExternalToolProposal,
  options: ExternalApprovalBridgeOptions,
): Promise<ExternalApprovalDecision> {
  if (proposal.sideEffect === "none" || proposal.sideEffect === "workspace_read") {
    return { approved: true };
  }
  if (!options.approvalBridgeVerified) {
    throw new Error("External approval bridge is not verified.");
  }
  const decision = await options.onApprovalRequired?.({
    toolCallId: proposal.backendToolCallId,
    toolName: proposal.toolName,
    input: proposal.input,
    defaultApproval: "ask",
  });
  if (!decision?.approved) {
    throw new Error("External tool proposal was not approved.");
  }
  return decision;
}
