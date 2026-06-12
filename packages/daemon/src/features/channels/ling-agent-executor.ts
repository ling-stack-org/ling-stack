import {
  createLingAgentSystemTeammate,
  isLingAgentTeammateId,
  LING_AGENT_ID,
  lingAgentAllowedTools,
  type AiTeammate,
  type RunTool,
} from "@ling-stack/core";

export const LING_AGENT_EXECUTOR_ID = LING_AGENT_ID;

export const lingAgentExecutorTools: readonly RunTool[] = lingAgentAllowedTools;

export function isLingAgentExecutorId(teammateId: string | undefined): boolean {
  return isLingAgentTeammateId(teammateId);
}

export function createLingAgentExecutor(now = "1970-01-01T00:00:00.000Z"): AiTeammate {
  return createLingAgentSystemTeammate(now);
}
