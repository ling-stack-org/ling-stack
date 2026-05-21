export const readOnlyRunTools = ["read", "grep", "find", "ls"] as const;
export const riskyRunTools = ["bash", "edit", "write"] as const;
export const approvalToolDecisions = ["allow", "ask", "deny"] as const;

export type ReadOnlyRunTool = (typeof readOnlyRunTools)[number];
export type RiskyRunTool = (typeof riskyRunTools)[number];
export type RunTool = ReadOnlyRunTool | RiskyRunTool;
export type ApprovalToolDecision = (typeof approvalToolDecisions)[number];
export type ApprovalToolDecisions = Readonly<Record<RunTool, ApprovalToolDecision>>;

export interface ApprovalPolicy {
  readonly workspaceId: string;
  readonly toolDecisions: ApprovalToolDecisions;
  readonly allowedWritePaths: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApprovalPolicyUpdateInput {
  readonly toolDecisions?: Partial<ApprovalToolDecisions>;
  readonly allowedWritePaths?: readonly string[];
}

export const defaultApprovalToolDecisions: ApprovalToolDecisions = {
  read: "allow",
  grep: "allow",
  find: "allow",
  ls: "allow",
  bash: "ask",
  edit: "ask",
  write: "ask",
};

export const defaultAllowedWritePaths: readonly string[] = ["."];

export function createDefaultApprovalPolicy(workspaceId: string, now: string): ApprovalPolicy {
  return {
    workspaceId,
    toolDecisions: defaultApprovalToolDecisions,
    allowedWritePaths: defaultAllowedWritePaths,
    createdAt: now,
    updatedAt: now,
  };
}

export function isRiskyRunTool(tool: string): tool is RiskyRunTool {
  return (riskyRunTools as readonly string[]).includes(tool);
}

export function listRiskyRunTools(tools: readonly string[] | undefined): RiskyRunTool[] {
  return [...new Set((tools ?? []).filter(isRiskyRunTool))];
}
