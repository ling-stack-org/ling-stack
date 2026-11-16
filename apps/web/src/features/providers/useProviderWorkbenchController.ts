import { useEffect, useMemo, useState } from "react";
import type { ProviderPreset } from "../../types.js";
import type { ProviderDeleteResult } from "./types.js";
import {
  filterProviderWorkbenchRoutes,
  type ProviderCapabilityFilter,
  type ProviderStatusFilter,
} from "./provider-workbench-view-models.js";

export function useProviderWorkbenchController(input: {
  readonly providers: readonly ProviderPreset[];
  readonly onDelete: (providerId: string) => Promise<ProviderDeleteResult>;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProviderStatusFilter>("all");
  const [capabilityFilter, setCapabilityFilter] = useState<ProviderCapabilityFilter>("all");
  const [deleteTarget, setDeleteTarget] = useState<ProviderPreset>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<ProviderDeleteResult>();
  const filteredProviders = useMemo(
    () => filterProviderWorkbenchRoutes({
      providers: input.providers,
      query,
      statusFilter,
      capabilityFilter,
    }),
    [capabilityFilter, input.providers, query, statusFilter],
  );

  useEffect(() => {
    if (!deleteTarget || !deleteBusy) return;
    if (!input.providers.some((provider) => provider.id === deleteTarget.id)) {
      setDeleteBusy(false);
      setDeleteTarget(undefined);
      return;
    }
  }, [deleteBusy, deleteTarget, input.providers]);

  function requestDelete(provider: ProviderPreset): void {
    setDeleteError(undefined);
    setDeleteBusy(false);
    setDeleteTarget(provider);
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || deleteBusy) return;
    setDeleteError(undefined);
    setDeleteBusy(true);
    const result = await input.onDelete(deleteTarget.id);
    setDeleteBusy(false);
    if (result.ok) {
      setDeleteTarget(undefined);
      return;
    }
    setDeleteError(result);
  }

  return {
    capabilityFilter,
    clearFilters: () => { setQuery(""); setStatusFilter("all"); setCapabilityFilter("all"); },
    closeDelete: () => { if (!deleteBusy) setDeleteTarget(undefined); },
    confirmDelete,
    deleteBusy,
    deleteErrorMessage: deleteError?.errorMessage ?? "",
    deleteErrorTechnicalMessage: deleteError?.errorTechnicalMessage,
    deleteTarget,
    filteredProviders,
    query,
    requestDelete,
    setCapabilityFilter,
    setQuery,
    setStatusFilter,
    statusFilter,
  } as const;
}
