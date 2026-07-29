import { useMemo, useState } from "react";
import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import type { Channel, ProviderPreset } from "../../types.js";
import { roleLabel } from "./helpers.js";
import {
  deriveTeammateManagementList,
  filterTeammateManagementRows,
  type TeammateManagementFilter,
} from "./teammate-management-list-view-models.js";
import type { LocalTeammateDraft } from "./types.js";

export function useTeammateManagementListController(input: {
  readonly channels: readonly Channel[];
  readonly providers: readonly ProviderPreset[];
  readonly teammates: readonly LocalTeammateDraft[];
  readonly templates: readonly AiTeammateTemplate[];
  readonly t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TeammateManagementFilter>("all");
  const model = useMemo(
    () => deriveTeammateManagementList(input),
    [input.channels, input.providers, input.teammates, input.templates],
  );
  const visibleRows = useMemo(
    () => filterTeammateManagementRows(model.rows, {
      filter,
      query,
      localizedSearchValues: (row) => [
        row.roleLabelKey ? input.t(row.roleLabelKey) : roleLabel(row.roleKey, input.t),
        row.modelLabelKey ? input.t(row.modelLabelKey) : row.modelLabel,
        ...row.channelNames,
      ],
    }),
    [filter, input.t, model.rows, query],
  );

  return {
    clearFilters: () => {
      setQuery("");
      setFilter("all");
    },
    filter,
    hasActiveFilters: Boolean(query.trim()) || filter !== "all",
    model,
    query,
    setFilter,
    setQuery,
    visibleRows,
  };
}
