import type {
  ChromeBrowserPairingStartResponse,
  ManagedPluginApplyPresetRequest,
  ManagedPluginApplyPresetResponse,
  ManagedPluginCheckResponse,
  ManagedPluginConnectRequest,
  ManagedPluginConnectResponse,
  ManagedPluginCreateRequest,
  ManagedPluginCreateResponse,
  ManagedPluginDisableRequest,
  ManagedPluginInstallRequest,
  ManagedPluginInstallResponse,
  ManagedPluginListResponse,
  ManagedPluginMutationResponse,
  ManagedPluginRefreshPackageResponse,
  ManagedPluginRuntimePreviewResponse,
  ManagedPluginUninstallRequest,
  ManagedPluginUninstallResponse,
  PluginPackageDetailResponse,
  PluginPackageValidationResponse,
  PluginSourceListResponse,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function listManagedPlugins(cwd: string): Promise<ManagedPluginListResponse> {
  return daemonClient.listManagedPlugins(cwd);
}

export async function createManagedPlugin(cwd: string, input: ManagedPluginCreateRequest): Promise<ManagedPluginCreateResponse> {
  return daemonClient.createManagedPlugin(cwd, input);
}

export async function enableManagedPlugin(cwd: string, pluginId: string): Promise<ManagedPluginMutationResponse> {
  return daemonClient.enableManagedPlugin(cwd, pluginId);
}

export async function disableManagedPlugin(cwd: string, pluginId: string, input: ManagedPluginDisableRequest = {}): Promise<ManagedPluginMutationResponse> {
  return daemonClient.disableManagedPlugin(cwd, pluginId, input);
}

export async function checkManagedPlugin(cwd: string, pluginId: string): Promise<ManagedPluginCheckResponse> {
  return daemonClient.checkManagedPlugin(cwd, pluginId);
}

export async function connectManagedPlugin(
  cwd: string,
  pluginId: string,
  input: ManagedPluginConnectRequest = {},
): Promise<ManagedPluginConnectResponse> {
  return daemonClient.connectManagedPlugin(cwd, pluginId, input);
}

export async function startChromeBrowserPairing(cwd: string, pluginId: string): Promise<ChromeBrowserPairingStartResponse> {
  return daemonClient.startChromeBrowserPairing(cwd, pluginId);
}

export async function revokeChromeBrowserAccess(cwd: string, pluginId: string): Promise<ManagedPluginMutationResponse> {
  return daemonClient.revokeChromeBrowserAccess(cwd, pluginId);
}

export async function applyManagedPluginPreset(
  cwd: string,
  pluginId: string,
  input: ManagedPluginApplyPresetRequest = {},
): Promise<ManagedPluginApplyPresetResponse> {
  return daemonClient.applyManagedPluginPreset(cwd, pluginId, input);
}

export async function installManagedPlugin(
  cwd: string,
  pluginId: string,
  input: ManagedPluginInstallRequest = {},
): Promise<ManagedPluginInstallResponse> {
  return daemonClient.installManagedPlugin(cwd, pluginId, input);
}

export async function uninstallManagedPlugin(
  cwd: string,
  pluginId: string,
  input: ManagedPluginUninstallRequest = {},
): Promise<ManagedPluginUninstallResponse> {
  return daemonClient.uninstallManagedPlugin(cwd, pluginId, input);
}

export async function refreshManagedPluginPackage(
  cwd: string,
  pluginId: string,
  input: ManagedPluginInstallRequest = {},
): Promise<ManagedPluginRefreshPackageResponse> {
  return daemonClient.refreshManagedPluginPackage(cwd, pluginId, input);
}

export async function getManagedPluginRuntimePreview(cwd: string, pluginId: string): Promise<ManagedPluginRuntimePreviewResponse> {
  return daemonClient.getManagedPluginRuntimePreview(cwd, pluginId);
}

export async function listPluginSources(cwd: string): Promise<PluginSourceListResponse> {
  return daemonClient.listPluginSources(cwd);
}

export async function getPluginPackage(cwd: string, pluginId: string): Promise<PluginPackageDetailResponse> {
  return daemonClient.getPluginPackage(cwd, pluginId);
}

export async function validatePluginPackage(cwd: string, pluginId: string): Promise<PluginPackageValidationResponse> {
  return daemonClient.validatePluginPackage(cwd, pluginId);
}
