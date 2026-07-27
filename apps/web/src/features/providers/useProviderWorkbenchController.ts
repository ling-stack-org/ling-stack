import { useEffect, useMemo, useState } from "react";
import type { ProviderPreset } from "../../types.js";
import { filterProviderWorkbenchRoutes, type ProviderStatusFilter } from "./provider-workbench-view-models.js";

export function useProviderWorkbenchController(input: {
  readonly providers: readonly ProviderPreset[];
  readonly selectedProviderId: string;
  readonly errorMessage: string;
  readonly onDelete: (providerId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProviderStatusFilter>("all");
  const [deleteTarget, setDeleteTarget] = useState<ProviderPreset>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErrorSnapshot, setDeleteErrorSnapshot] = useState("");
  const filteredProviders = useMemo(
    () => filterProviderWorkbenchRoutes({
      providers: input.providers,
      query,
      statusFilter,
      selectedProviderId: input.selectedProviderId,
    }),
    [input.providers, input.selectedProviderId, query, statusFilter],
  );

  useEffect(() => {
    if (!deleteTarget || !deleteBusy) return;
    if (!input.providers.some((provider) => provider.id === deleteTarget.id)) {
      setDeleteBusy(false);
      setDeleteTarget(undefined);
      return;
    }
    if (input.errorMessage && input.errorMessage !== deleteErrorSnapshot) setDeleteBusy(false);
  }, [deleteBusy, deleteErrorSnapshot, deleteTarget, input.errorMessage, input.providers]);

  function requestDelete(provider: ProviderPreset): void {
    setDeleteErrorSnapshot(input.errorMessage);
    setDeleteBusy(false);
    setDeleteTarget(provider);
  }

  function confirmDelete(): void {
    if (!deleteTarget || deleteBusy) return;
    setDeleteErrorSnapshot(input.errorMessage);
    setDeleteBusy(true);
    input.onDelete(deleteTarget.id);
  }

  return {
    clearFilters: () => { setQuery(""); setStatusFilter("all"); },
    closeDelete: () => { if (!deleteBusy) setDeleteTarget(undefined); },
    confirmDelete,
    deleteBusy,
    deleteErrorMessage: deleteTarget && input.errorMessage !== deleteErrorSnapshot ? input.errorMessage : "",
    deleteTarget,
    filteredProviders,
    query,
    requestDelete,
    setQuery,
    setStatusFilter,
    statusFilter,
  } as const;
}
