import type { PiRunnerBuiltinToolName, PiRunnerProviderApi } from "./types.js";

export const DEFAULT_TOOLS: readonly PiRunnerBuiltinToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const SUPPORTED_PROVIDER_APIS: readonly PiRunnerProviderApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
];
export const APPROVAL_REQUIRED_TOOLS = new Set<string>(DEFAULT_TOOLS);
export const SIDE_EFFECT_TOOLS = new Set<string>(["bash", "edit", "write"]);
