import type { AiTeammate } from "../../types.js";

export interface TeammateDangerViewModel {
  readonly protectedTeammate: boolean;
  readonly protectedDescriptionKey: "Ling Agent keeps lifecycle and permissions managed by Ling Stack." | "Managed by Ling Stack";
}

export function buildTeammateDangerViewModel(teammate: AiTeammate): TeammateDangerViewModel {
  const lingAgent = teammate.systemRole === "ling_agent" || teammate.id === "ling_agent";
  const protectedTeammate = Boolean(
    teammate.protectedProfile || teammate.kind === "system_teammate" || lingAgent,
  );
  return {
    protectedTeammate,
    protectedDescriptionKey: lingAgent
      ? "Ling Agent keeps lifecycle and permissions managed by Ling Stack."
      : "Managed by Ling Stack",
  };
}
