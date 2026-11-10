import type { ProviderPreset } from "../types.js";

export function providerCompactModelLabel(
  provider: Pick<ProviderPreset, "displayName" | "model">,
): string {
  return provider.model.trim() || provider.displayName.trim();
}

export function formatProviderModelRouteLabel(modelLabel: string, routeLabel: string): string {
  const normalizedModel = modelLabel.trim();
  const normalizedRoute = routeLabel.trim();
  if (!normalizedModel) return normalizedRoute;
  if (!normalizedRoute || normalizedRoute.toLowerCase() === normalizedModel.toLowerCase()) return normalizedModel;
  return `${normalizedModel} · ${normalizedRoute}`;
}

export function providerDisplaySourceLabel(displayName: string, model: string): string {
  const trimmedDisplayName = displayName.trim();
  const trimmedModel = model.trim();
  if (!trimmedDisplayName || !trimmedModel) {
    return trimmedDisplayName;
  }
  const suffixes = [` · ${trimmedModel}`, ` / ${trimmedModel}`, ` - ${trimmedModel}`];
  const matchingSuffix = suffixes.find((suffix) => trimmedDisplayName.toLowerCase().endsWith(suffix.toLowerCase()));
  return matchingSuffix
    ? trimmedDisplayName.slice(0, -matchingSuffix.length).trim()
    : trimmedDisplayName;
}
