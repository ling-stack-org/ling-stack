import { DefaultResourceLoader, type ResourceLoader, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLingStackApprovalExtension } from "./extensions/approval.js";
import { assertHostCapabilityToolSurface, createLingStackHostCapabilityExtension } from "./extensions/host-capability.js";
import { createLingStackBashToolExtension } from "./extensions/bash.js";
import { createLingStackFileMutationToolExtension } from "./extensions/file-mutation.js";
import { assertHostReadonlyToolSurface, createLingStackHostReadonlyExtension } from "./extensions/host-readonly.js";
import { assertHostIsolatedFilesToolSurface, createLingStackHostIsolatedFilesExtension } from "./extensions/host-isolated-files.js";
import { createLingStackMcpProxyExtension } from "./extensions/mcp-proxy.js";
import { createLingStackMediaGenerationExtension } from "./extensions/media-generation.js";
import { createLingStackPermissionRequestExtension } from "./extensions/permissions.js";
import { createLingStackToolHydrationExtension } from "./extensions/tool-hydration.js";
import { createLingStackTaskContinuationExtension } from "./extensions/task-continuation.js";
import { createLingStackUserInputExtension, isUserInputToolSurfaceEnabled } from "./extensions/user-input.js";
import { createLingStackDelegationExtension, isDelegationToolSurfaceEnabled } from "./extensions/delegation.js";
import { createLingStackToolBeforeExtension } from "./extensions/tool-before.js";
import { createLingStackModelContextBudgetExtension } from "./model-context-budget.js";
import type { PiRunnerRunOptions } from "./types.js";
import { formatTaskPrompt, getLingStackSystemPrompt } from "./utils.js";

export async function createLingStackResourceLoader(
  options: PiRunnerRunOptions,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<ResourceLoader> {
  assertHostIsolatedFilesToolSurface(options);
  assertHostCapabilityToolSurface(options);
  assertHostReadonlyToolSurface(options);
  const isolated = options.isolatedToolsProfile === "host_isolated_files_v1";
  // Adapter/boundary resolve this profile's safe defaults before session-factory selects SDK tools.
  if (isolated && options.tools === undefined) throw new Error("workflow_isolated_tool_selection_missing");
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
    appendSystemPrompt: [...(options.appendSystemPrompt ?? []),
      ...(isolated ? ["Host tool producer profile: host_isolated_files_v1. File tools dispatch only to live Host handlers; the profile itself is not OS isolation or authorization."] : [])],
    extensionFactories: [
      createLingStackModelContextBudgetExtension({ acceptedTaskPrompt: options.preparedInput?.userPrompt ?? formatTaskPrompt(options.task) }),
      ...(options.onTaskContinuationBoundary ? [createLingStackTaskContinuationExtension(options)] : []),
      ...(isolated ? [createLingStackToolBeforeExtension(options), createLingStackHostIsolatedFilesExtension(options)] : [
        ...(isUserInputToolSurfaceEnabled(options) ? [createLingStackUserInputExtension(options)] : []),
        ...(isDelegationToolSurfaceEnabled(options) ? [createLingStackDelegationExtension(options)] : []),
        ...(options.onToolBefore ? [createLingStackToolBeforeExtension(options)] : []),
        ...(options.readonlyToolsProfile ? [createLingStackHostReadonlyExtension(options)] : []),
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
      ]),
    ],
  });
  await resourceLoader.reload();
  return resourceLoader;
}
