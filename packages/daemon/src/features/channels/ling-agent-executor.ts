import type { AiTeammate, RunTool } from "@ling-stack/core";

export const LING_AGENT_EXECUTOR_ID = "ling_agent";

export const lingAgentExecutorTools: readonly RunTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

export function isLingAgentExecutorId(teammateId: string | undefined): boolean {
  return teammateId === LING_AGENT_EXECUTOR_ID;
}

export function createLingAgentExecutor(now = "1970-01-01T00:00:00.000Z"): AiTeammate {
  return {
    id: LING_AGENT_EXECUTOR_ID,
    workspaceId: "workspace_default",
    templateId: LING_AGENT_EXECUTOR_ID,
    roleKey: "custom",
    displayName: "Ling Agent",
    description: "Built-in executor for bounded channel tasks when no specialist teammate is required.",
    avatarTone: "violet",
    appendSystemPrompt: [],
    allowedTools: lingAgentExecutorTools,
    approvalProfile: { mode: "standard", risk: "medium" },
    status: "active",
    pinned: true,
    hidden: false,
    createdAt: now,
    updatedAt: now,
  };
}
