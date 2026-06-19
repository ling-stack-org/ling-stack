import { DefaultResourceLoader, type ResourceLoader, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLingStackApprovalExtension } from "./extensions/approval.js";
import { createLingStackBashToolExtension } from "./extensions/bash.js";
import { createLingStackFileMutationToolExtension } from "./extensions/file-mutation.js";
import { createLingStackMcpProxyExtension } from "./extensions/mcp-proxy.js";
import { createLingStackPermissionRequestExtension } from "./extensions/permissions.js";
import { createLingStackToolHydrationExtension } from "./extensions/tool-hydration.js";
import type { PiRunnerRunOptions } from "./types.js";
import { getLingStackSystemPrompt } from "./utils.js";

export async function createLingStackResourceLoader(
  options: PiRunnerRunOptions,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<ResourceLoader> {
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
      createLingStackFileMutationToolExtension(options),
      ...(options.runtimeToolFeatures?.unifiedExec ? [createLingStackBashToolExtension(options)] : []),
      createLingStackApprovalExtension(options),
      ...(options.runtimeToolFeatures?.requestPermissions ? [createLingStackPermissionRequestExtension(options)] : []),
      ...(options.mcpTools?.length ? [createLingStackMcpProxyExtension(options)] : []),
      ...(options.onToolHydrationRequest ? [createLingStackToolHydrationExtension(options)] : []),
    ],
  });
  await resourceLoader.reload();
  return resourceLoader;
}
