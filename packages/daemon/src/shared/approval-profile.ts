import { readOnlyRunTools, type SkillApprovalProfile } from "@ling-stack/core";
import { readOptionalString, readOptionalStringArray } from "./validation.js";

export function parseApprovalProfileObject(value: Record<string, unknown>, key: string): SkillApprovalProfile {
  if (value.mode !== "none" && value.mode !== "standard" && value.mode !== "strict") {
    throw new Error(`${key}.mode must be one of: none, standard, strict`);
  }
  const requiredForTools = readOptionalStringArray(value, "requiredForTools", [...readOnlyRunTools, "bash", "edit", "write"] as const);
  const requiredForActions = readOptionalStringArray(value, "requiredForActions", [
    "write",
    "edit",
    "bash",
    "git_commit",
    "git_push",
    "external_send",
    "deploy",
    "media_cost",
    "credential_change",
    "provider_change",
    "mcp_tool_call",
  ] as const);
  const risk = readOptionalString(value, "risk");
  if (risk !== undefined && risk !== "low" && risk !== "medium" && risk !== "high" && risk !== "critical") {
    throw new Error(`${key}.risk must be one of: low, medium, high, critical`);
  }
  return {
    mode: value.mode,
    ...(risk ? { risk: risk as SkillApprovalProfile["risk"] } : {}),
    ...(requiredForTools ? { requiredForTools } : {}),
    ...(requiredForActions ? { requiredForActions } : {}),
  };
}
