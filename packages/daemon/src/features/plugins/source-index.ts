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
  readonly sourceKind: "built-in" | "bundled" | "official-remote" | "trusted-local";
  readonly manifest: LoadedPluginPackage["manifest"];
}

export function listPluginSourceViews(): readonly PluginSourceView[] {
  const packages = listBundledPluginPackages();
  if (packages.length === 0) return [];
  return [{
    id: "bundled:official",
    sourceKind: "bundled",
    displayName: "Ling bundled plugins",
    pluginCount: packages.length,
    pluginIds: packages.map((pluginPackage) => pluginPackage.id),
  }];
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
  return listBundledPluginPackages().find((pluginPackage) => pluginPackage.id === pluginId);
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
