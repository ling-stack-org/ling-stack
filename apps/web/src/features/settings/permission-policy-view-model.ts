import type { ApprovalPolicyFormState, ApprovalToolDecision, ToolName } from "../../types.js";

export type PermissionToolGroupId = "read_search" | "execute_modify";
export type PermissionGroupDecision = ApprovalToolDecision | "mixed";

export interface PermissionToolGroup {
  readonly id: PermissionToolGroupId;
  readonly labelKey: string;
  readonly tools: readonly ToolName[];
}

export const permissionToolGroups: readonly PermissionToolGroup[] = [
  {
    id: "read_search",
    labelKey: "Read and search",
    tools: ["read", "grep", "find", "ls"],
  },
  {
    id: "execute_modify",
    labelKey: "Execute and modify",
    tools: ["bash", "edit", "write"],
  },
];

export const permissionToolLabelKeys: Readonly<Record<ToolName, string>> = {
  read: "Read files",
  grep: "Search file contents",
  find: "Find files",
  ls: "List folders",
  bash: "Run commands",
  edit: "Edit files",
  write: "Write files",
};

export function permissionGroupDecision(
  form: ApprovalPolicyFormState,
  group: PermissionToolGroup,
): PermissionGroupDecision {
  const firstDecision = form.toolDecisions[group.tools[0]];
  return group.tools.every((tool) => form.toolDecisions[tool] === firstDecision)
    ? firstDecision
    : "mixed";
}

export function applyPermissionGroupDecision(
  form: ApprovalPolicyFormState,
  group: PermissionToolGroup,
  decision: ApprovalToolDecision,
): ApprovalPolicyFormState {
  const toolDecisions = { ...form.toolDecisions };
  for (const tool of group.tools) {
    toolDecisions[tool] = decision;
  }
  return { ...form, toolDecisions };
}

export function applyPermissionToolDecision(
  form: ApprovalPolicyFormState,
  tool: ToolName,
  decision: ApprovalToolDecision,
): ApprovalPolicyFormState {
  return {
    ...form,
    toolDecisions: {
      ...form.toolDecisions,
      [tool]: decision,
    },
  };
}

export function parseAllowedWritePaths(value: string): readonly string[] {
  const uniquePaths = new Set<string>();
  for (const line of value.split(/\r?\n/u)) {
    const path = line.trim();
    if (path) {
      uniquePaths.add(path);
    }
  }
  return [...uniquePaths];
}

export function serializeAllowedWritePaths(paths: readonly string[]): string {
  return parseAllowedWritePaths(paths.join("\n")).join("\n");
}

export function addAllowedWritePath(
  form: ApprovalPolicyFormState,
  nextPath: string,
): ApprovalPolicyFormState {
  const normalizedPath = nextPath.trim();
  if (!normalizedPath) {
    return form;
  }
  const paths = parseAllowedWritePaths(form.allowedWritePathsText);
  if (paths.includes(normalizedPath)) {
    return form;
  }
  return {
    ...form,
    allowedWritePathsText: serializeAllowedWritePaths([...paths, normalizedPath]),
  };
}

export function removeAllowedWritePath(
  form: ApprovalPolicyFormState,
  pathToRemove: string,
): ApprovalPolicyFormState {
  return {
    ...form,
    allowedWritePathsText: serializeAllowedWritePaths(
      parseAllowedWritePaths(form.allowedWritePathsText).filter((path) => path !== pathToRemove),
    ),
  };
}

export function approvalPolicyFormsEqual(
  left: ApprovalPolicyFormState,
  right: ApprovalPolicyFormState,
): boolean {
  for (const group of permissionToolGroups) {
    for (const tool of group.tools) {
      if (left.toolDecisions[tool] !== right.toolDecisions[tool]) {
        return false;
      }
    }
  }
  return serializeAllowedWritePaths(parseAllowedWritePaths(left.allowedWritePathsText))
    === serializeAllowedWritePaths(parseAllowedWritePaths(right.allowedWritePathsText));
}
