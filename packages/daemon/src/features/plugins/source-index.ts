import type { ManagedPluginDescriptor } from "@ling-stack/core";
import { listBundledPluginIndexEntries, type BundledPluginIndexEntry } from "./bundled-index.js";
import { loadPluginPackageFromRoot, type LoadedPluginPackage } from "./manifest.js";

export interface PluginSourceView {
  readonly id: string;
  readonly sourceKind: "bundled";
  readonly displayName: string;
  readonly pluginCount: number;
  readonly pluginIds: readonly string[];
}

export interface PluginPackageView {
  readonly id: string;
  readonly sourceKind: "bundled" | "trusted-local";
  readonly manifest: LoadedPluginPackage["manifest"];
}

export function listPluginSourceViews(): readonly PluginSourceView[] {
  const entries = listBundledPluginIndexEntries();
  return [
    {
      id: "bundled",
      sourceKind: "bundled",
      displayName: "Bundled plugins",
      pluginCount: entries.length,
      pluginIds: entries.map((entry) => entry.id),
    },
  ];
}

export function listBundledPluginPackages(): readonly LoadedPluginPackage[] {
  return listBundledPluginIndexEntries().map(loadBundledPackage);
}

export function listBundledPackageDescriptors(): readonly ManagedPluginDescriptor[] {
  return listBundledPluginPackages()
    .map((pluginPackage) => pluginPackage.validation.compiledDescriptor)
    .filter((descriptor): descriptor is ManagedPluginDescriptor => Boolean(descriptor));
}

export function getBundledPluginPackage(pluginId: string): LoadedPluginPackage | undefined {
  const entry = listBundledPluginIndexEntries().find((candidate) => candidate.id === pluginId);
  return entry ? loadBundledPackage(entry) : undefined;
}

export function toPluginPackageView(pluginPackage: LoadedPluginPackage): PluginPackageView {
  return {
    id: pluginPackage.id,
    sourceKind: pluginPackage.sourceKind,
    manifest: pluginPackage.manifest,
  };
}

function loadBundledPackage(entry: BundledPluginIndexEntry): LoadedPluginPackage {
  return loadPluginPackageFromRoot(entry.packageRoot);
}
