export const readOnlyRunTools = ["read", "grep", "find", "ls"] as const;
export const riskyRunTools = ["bash", "edit", "write"] as const;

export type ReadOnlyRunTool = (typeof readOnlyRunTools)[number];
export type RiskyRunTool = (typeof riskyRunTools)[number];
export type RunTool = ReadOnlyRunTool | RiskyRunTool;

export function isRiskyRunTool(tool: string): tool is RiskyRunTool {
  return (riskyRunTools as readonly string[]).includes(tool);
}

export function listRiskyRunTools(tools: readonly string[] | undefined): RiskyRunTool[] {
  return [...new Set((tools ?? []).filter(isRiskyRunTool))];
}
