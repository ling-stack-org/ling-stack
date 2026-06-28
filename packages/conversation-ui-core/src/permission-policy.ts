export type ConversationPermissionPreset =
  | "read_only"
  | "workspace_collaboration"
  | "full_access"
  | "custom";

export interface ConversationPermissionPresetOption {
  readonly preset: ConversationPermissionPreset;
  readonly label: string;
  readonly description: string;
  readonly requiresConfirmation?: boolean;
}

export const defaultConversationPermissionPresetOptions: readonly ConversationPermissionPresetOption[] = [
  {
    preset: "read_only",
    label: "Read only",
    description: "Inspect context without changing files or running write actions.",
  },
  {
    preset: "workspace_collaboration",
    label: "Workspace",
    description: "Allow normal workspace collaboration with approval-gated risky actions.",
  },
  {
    preset: "full_access",
    label: "Full access",
    description: "Allow broad local file, network, and tool access for the next run.",
    requiresConfirmation: true,
  },
  {
    preset: "custom",
    label: "Custom",
    description: "Use the custom permission profile configured for this surface.",
  },
] as const;

export function conversationPermissionPresetRequiresConfirmation(
  preset: ConversationPermissionPreset,
  options: readonly ConversationPermissionPresetOption[] = defaultConversationPermissionPresetOptions,
): boolean {
  return options.some((option) => option.preset === preset && option.requiresConfirmation === true);
}
