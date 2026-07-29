import type { PluginManagerFilters, PluginRowView } from "./plugin-manager-types.js";

export function filterPluginRows(
  rows: readonly PluginRowView[],
  filters: PluginManagerFilters,
): readonly PluginRowView[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (query && !`${row.name}\n${row.description}`.toLocaleLowerCase().includes(query)) return false;
    if (filters.source !== "all" && row.sourceKind !== filters.source) return false;
    if (filters.status !== "all" && row.filterGroup !== filters.status) return false;
    return true;
  });
}

export function hasActivePluginFilters(filters: PluginManagerFilters): boolean {
  return Boolean(filters.query.trim()) || filters.source !== "all" || filters.status !== "all";
}
