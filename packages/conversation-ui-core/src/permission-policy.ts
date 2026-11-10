export type ConversationPermissionPreset =
  | "read_only"
  | "workspace_collaboration"
  | "full_access"
  | "custom";

export type ConversationAuthorizationMode = "ask" | "smart" | "always";

export interface ConversationAuthorizationModeOption {
  readonly mode: ConversationAuthorizationMode;
  readonly label: string;
  readonly description: string;
}

export const defaultConversationAuthorizationModeOptions: readonly ConversationAuthorizationModeOption[] = [
  {
    mode: "ask",
    label: "Request approval",
    description: "Ask before operations that require approval.",
  },
  {
    mode: "smart",
    label: "Help me approve",
    description: "Use a locked-down reviewer for approval requests and ask you when review is inconclusive.",
  },
  {
    mode: "always",
    label: "Always authorize",
    description: "Automatically authorize operations allowed by the selected sandbox and safety policy.",
  },
] as const;

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
