import type {
  ApprovalActionType,
  ApprovalRisk,
  ProviderCapability,
  SkillRevisionPreview,
  ToolName,
} from "../../types.js";
import type { SkillEditorForm } from "./skill-editor-utils.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export function toolLabel(value: ToolName): string {
  const labels: Record<ToolName, string> = {
    read: "Read files",
    grep: "Search file contents",
    find: "Find files",
    ls: "List folders",
    bash: "Run commands",
    edit: "Edit files",
    write: "Create files",
  };
  return labels[value];
}

export function providerCapabilityLabel(value: ProviderCapability): string {
  const labels: Record<ProviderCapability, string> = {
    chat: "Chat",
    tool_call: "Tool calling",
    reasoning: "Reasoning",
    vision: "Image understanding",
    web_search: "Web search",
    embedding: "Embeddings",
    image_generate: "Image generation",
    image_edit: "Image editing",
    video_generate: "Video generation",
    tts: "Text to speech",
    asr: "Speech recognition",
  };
  return labels[value];
}

export function approvalModeLabel(value: SkillEditorForm["approvalMode"]): string {
  if (value === "standard") return "Standard approval";
  if (value === "strict") return "Strict approval";
  return "No extra approval";
}

export function approvalRiskLabel(value: ApprovalRisk): string {
  if (value === "low") return "Low";
  if (value === "medium") return "Medium";
  if (value === "high") return "High";
  return "Critical";
}

export function approvalActionLabel(value: ApprovalActionType): string {
  const labels: Record<ApprovalActionType, string> = {
    read: "Read files",
    grep: "Search file contents",
    find: "Find files",
    ls: "List folders",
    write: "Create files",
    edit: "Edit files",
    bash: "Run commands",
    git_commit: "Create Git commits",
    git_push: "Push Git changes",
    external_send: "Send externally",
    deploy: "Deploy",
    media_cost: "Paid media generation",
    credential_change: "Change credentials",
    provider_change: "Change model provider",
    workflow_step: "Run workflow steps",
    mcp_tool_call: "Call MCP tools",
    runtime_permission_request: "Request runtime permissions",
  };
  return labels[value];
}

export function warningLabel(code: SkillRevisionPreview["warnings"][number]["code"]): string {
  if (code === "permission_like_instruction") return "The instructions mention permissions. Ling still enforces the configured approval policy.";
  if (code === "secret_reference") return "The instructions mention credentials. Secrets must be configured separately.";
  if (code === "external_send_claim") return "The instructions mention external actions. Those actions still require approval.";
  if (code === "unknown_tool") return "A required tool is not supported.";
  if (code === "unknown_provider_capability") return "A required model capability is not supported.";
  if (code === "duplicate_skill_id") return "A skill with the same identity already exists.";
  if (code === "unsupported_section") return "Some content cannot be represented by this editor.";
  return "Required skill information is missing.";
}

export function authorityListDiffText<T extends string>(
  before: readonly T[],
  after: readonly T[],
  label: (value: T) => string,
  t: SettingsTranslator,
): string {
  const added = after.filter((value) => !before.includes(value)).map(label);
  const removed = before.filter((value) => !after.includes(value)).map(label);
  return [
    ...(added.length > 0 ? [t("Added: {items}", { items: added.join(", ") })] : []),
    ...(removed.length > 0 ? [t("Removed: {items}", { items: removed.join(", ") })] : []),
  ].join("; ");
}

export function approvalProfileSummary(
  profile: SkillRevisionPreview["authorityDiff"]["before"]["approvalProfile"],
  t: SettingsTranslator,
): string {
  const parts = [t(approvalModeLabel(profile.mode))];
  if (profile.risk) parts.push(t(approvalRiskLabel(profile.risk)));
  if (profile.requiredForTools?.length) parts.push(t("{count} approval tools", { count: profile.requiredForTools.length }));
  if (profile.requiredForActions?.length) parts.push(t("{count} approval actions", { count: profile.requiredForActions.length }));
  return parts.join(" / ");
}
