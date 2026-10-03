import { DefaultResourceLoader, type ResourceLoader, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLingStackApprovalExtension } from "./extensions/approval.js";
import { assertHostCapabilityToolSurface, createLingStackHostCapabilityExtension } from "./extensions/host-capability.js";
import { createLingStackBashToolExtension } from "./extensions/bash.js";
import { createLingStackFileMutationToolExtension } from "./extensions/file-mutation.js";
import { createLingStackMcpProxyExtension } from "./extensions/mcp-proxy.js";
import { createLingStackMediaGenerationExtension } from "./extensions/media-generation.js";
import { createLingStackPermissionRequestExtension } from "./extensions/permissions.js";
import { createLingStackToolHydrationExtension } from "./extensions/tool-hydration.js";
import { createLingStackTaskContinuationExtension } from "./extensions/task-continuation.js";
import { createLingStackUserInputExtension, isUserInputToolSurfaceEnabled } from "./extensions/user-input.js";
import { createLingStackToolBeforeExtension } from "./extensions/tool-before.js";
import { createLingStackModelContextBudgetExtension } from "./model-context-budget.js";
import type { PiRunnerRunOptions } from "./types.js";
import { formatTaskPrompt, getLingStackSystemPrompt } from "./utils.js";

export async function createLingStackResourceLoader(
  options: PiRunnerRunOptions,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<ResourceLoader> {
  assertHostCapabilityToolSurface(options);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: getLingStackSystemPrompt(options),
    appendSystemPrompt: [...(options.appendSystemPrompt ?? [])],
    extensionFactories: [
      createLingStackModelContextBudgetExtension({ acceptedTaskPrompt: options.preparedInput?.userPrompt ?? formatTaskPrompt(options.task) }),
      ...(options.onTaskContinuationBoundary ? [createLingStackTaskContinuationExtension(options)] : []),
      ...(isUserInputToolSurfaceEnabled(options) ? [createLingStackUserInputExtension(options)] : []),
      ...(options.onToolBefore ? [createLingStackToolBeforeExtension(options)] : []),
      createLingStackFileMutationToolExtension(options),
      // Bash always has a Host result. Feature flags cannot re-enable an unjournaled SDK spawn.
      createLingStackBashToolExtension(options),
      createLingStackApprovalExtension(options),
      ...(options.hostCapabilityTools?.length ? [createLingStackHostCapabilityExtension(options)] : []),
      ...(options.runtimeToolFeatures?.requestPermissions ? [createLingStackPermissionRequestExtension(options)] : []),
      ...(options.mcpTools?.length ? [createLingStackMcpProxyExtension(options)] : []),
      ...((options.initialToolSurface?.mediaGeneration ?? Boolean(options.onMediaGenerationToolCall)) && options.mediaGenerationTools?.some((tool) => tool.targets.length > 0)
        ? [createLingStackMediaGenerationExtension(options)]
        : []),
      ...((options.initialToolSurface?.toolHydration ?? Boolean(options.onToolHydrationRequest)) ? [createLingStackToolHydrationExtension(options)] : []),
    ],
  });
  await resourceLoader.reload();
  return resourceLoader;
}
