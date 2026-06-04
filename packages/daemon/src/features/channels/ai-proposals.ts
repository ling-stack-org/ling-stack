import type {
  ChannelExecutionProposalStep,
  CreateChannelExecutionProposalInput,
  RunTool,
} from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";

export function extractChannelExecutionProposal(
  body: string,
  fallbackTeammateId: string,
  isRunTool: (value: unknown) => value is RunTool,
): (Pick<CreateChannelExecutionProposalInput, "title" | "prompt" | "assigneeTeammateId" | "acceptanceCriteria" | "collaborationSteps" | "requiredTools" | "riskSummary"> & { readonly visibleBody: string }) | undefined {
  const match = /<ling_task_proposal>([\s\S]*?)<\/ling_task_proposal>/i.exec(body);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1] ?? "");
    if (!isRecord(parsed)) {
      return undefined;
    }
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
    if (!title || !prompt) {
      return undefined;
    }
    const assigneeTeammateId = typeof parsed.assigneeTeammateId === "string" && parsed.assigneeTeammateId.trim()
      ? parsed.assigneeTeammateId.trim()
      : fallbackTeammateId;
    const acceptanceCriteria = Array.isArray(parsed.acceptanceCriteria)
      ? parsed.acceptanceCriteria.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const requiredTools = Array.isArray(parsed.requiredTools) ? parsed.requiredTools.filter(isRunTool) : [];
    const collaborationSteps = parseProposalCollaborationSteps(parsed.collaborationSteps, fallbackTeammateId);
    const visibleBody = body.replace(match[0], "").trim() || "我整理了一个可执行提案，确认后可以交给队友开始处理。";
    return {
      visibleBody,
      title,
      prompt,
      assigneeTeammateId,
      acceptanceCriteria,
      collaborationSteps,
      requiredTools,
      riskSummary: typeof parsed.riskSummary === "string" && parsed.riskSummary.trim() ? parsed.riskSummary.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

function parseProposalCollaborationSteps(value: unknown, fallbackTeammateId: string): ChannelExecutionProposalStep[] {
  if (!Array.isArray(value)) {
    return [{ teammateId: fallbackTeammateId, action: "coordinated", summary: "Drafted an execution proposal from the channel discussion." }];
  }
  const steps = value.flatMap((item): ChannelExecutionProposalStep[] => {
    if (!isRecord(item)) {
      return [];
    }
    const teammateId = typeof item.teammateId === "string" && item.teammateId.trim() ? item.teammateId.trim() : fallbackTeammateId;
    const action = typeof item.action === "string" && isChannelExecutionProposalStepAction(item.action) ? item.action : "consulted";
    const summary = typeof item.summary === "string" && item.summary.trim() ? item.summary.trim() : "Contributed to the execution proposal.";
    return [{ teammateId, action, summary }];
  });
  return steps.length > 0 ? steps : [{ teammateId: fallbackTeammateId, action: "coordinated", summary: "Drafted an execution proposal from the channel discussion." }];
}

function isChannelExecutionProposalStepAction(value: string): value is ChannelExecutionProposalStep["action"] {
  return value === "coordinated" || value === "consulted" || value === "reviewed" || value === "flagged_risk";
}
