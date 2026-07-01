import type {
  ApprovalActionType,
  ApprovalPayload,
  EffectiveRunPolicySnapshot,
  RuntimePermissionRequestPayload,
} from "@ling-stack/core";

export interface PlanModeDenial {
  readonly reason: string;
}

export function evaluatePlanModeApprovalDenial(input: {
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly actionType: ApprovalActionType;
  readonly payload: ApprovalPayload;
}): PlanModeDenial | undefined {
  if (input.effectivePolicySnapshot?.conversationMode !== "plan") {
    return undefined;
  }
  if (input.payload.type === "file_write" || input.payload.type === "file_edit") {
    return {
      reason: "Plan Mode denied file mutation. Exit Plan Mode or accept a proposed plan before editing files.",
    };
  }
  if (input.payload.type === "bash" && isPlanModeMutationCommand(input.payload.command)) {
    return {
      reason: "Plan Mode denied a mutating shell command. Exit Plan Mode or accept a proposed plan before implementation.",
    };
  }
  if (
    input.actionType === "git_commit" ||
    input.actionType === "git_push" ||
    input.actionType === "deploy" ||
    input.actionType === "provider_change" ||
    input.actionType === "external_send"
  ) {
    return {
      reason: "Plan Mode denied an external or history-changing action. Exit Plan Mode before implementation.",
    };
  }
  return undefined;
}

export function evaluatePlanModePermissionDenial(input: {
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly payload: RuntimePermissionRequestPayload;
}): PlanModeDenial | undefined {
  if (input.effectivePolicySnapshot?.conversationMode !== "plan") {
    return undefined;
  }
  const scope = input.payload.requestedScope;
  if (scope.kind === "core_tool" && scope.tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write")) {
    return {
      reason: "Plan Mode denied expanding runtime permissions to mutation-capable tools.",
    };
  }
  if (scope.kind === "write_scope") {
    return {
      reason: "Plan Mode denied expanding runtime write scope.",
    };
  }
  if (scope.kind === "mcp_tool" && scope.sideEffectLevel !== "read") {
    return {
      reason: "Plan Mode denied a side-effecting MCP permission request.",
    };
  }
  if (scope.kind === "runner_capability") {
    return {
      reason: "Plan Mode denied expanding runner capabilities.",
    };
  }
  return undefined;
}

function isPlanModeMutationCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  const mutatingPatterns: readonly RegExp[] = [
    /(^|[;&|]\s*)apply_patch\b/i,
    /(^|[;&|]\s*)(?:rm|mv|cp|mkdir|rmdir|touch|ln)\b/i,
    /(^|[;&|]\s*)git\s+(?:add|commit|push|reset|rebase|merge|tag|clean|restore|checkout|switch|rm)\b/i,
    /(^|[;&|]\s*)git\s+push\b/i,
    /(^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|link|publish|version)\b/i,
    /(^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|format|format:write|lint:fix|fix|codegen|generate|migrate)\b/i,
    /(^|[;&|]\s*)(?:prettier|eslint|ruff|black|isort|gofmt|cargo\s+fmt)\b/i,
    /(^|[;&|]\s*)(?:prisma|drizzle|sequelize|typeorm|knex)\b[^\n]*(?:migrate|generate|push)\b/i,
    /(^|[;&|]\s*)(?:chmod|chown)\b/i,
    /(^|[;&|]\s*)(?:kubectl|helm|flyctl|vercel|netlify|aws|gcloud|az)\b[^\n]*(?:apply|delete|deploy|destroy|terminate|create|update|put|push)\b/i,
    /\b(?:sed\s+-i|perl\s+-pi)\b/i,
    /(^|[^&|])>{1,2}\s*[^&\s]/,
    /\btee\s+(?:-a\s+)?[^\s|;&]+/i,
  ];
  return mutatingPatterns.some((pattern) => pattern.test(normalized));
}
