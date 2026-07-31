import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import { providerPreflightReady } from "../../lib/providers.js";
import type { Channel, ProviderPreset } from "../../types.js";
import type { LocalTeammateDraft } from "./types.js";

export type TeammateManagementFilter = "all" | "hidden" | "needs-model" | "ready";
export type TeammateManagementPrimaryAction = "configure-model" | "open";
export type TeammateManagementStatusId = "hidden" | "needs-model" | "ready";

export interface TeammateManagementRowViewModel {
  readonly channelNames: readonly string[];
  readonly draft: LocalTeammateDraft;
  readonly modelLabel: string;
  readonly modelLabelKey?: string;
  readonly primaryAction: TeammateManagementPrimaryAction;
  readonly roleKey: AiTeammateTemplate["roleKey"];
  readonly roleLabelKey?: string;
  readonly searchValues: readonly string[];
  readonly status: {
    readonly className: "hidden" | "ready" | "warning";
    readonly id: TeammateManagementStatusId;
    readonly labelKey: "Hidden" | "Needs model" | "Ready teammate";
    readonly tone: "neutral" | "success" | "warning";
  };
}

export interface TeammateManagementListViewModel {
  readonly counts: {
    readonly active: number;
    readonly hidden: number;
    readonly needsModel: number;
    readonly ready: number;
  };
  readonly rows: readonly TeammateManagementRowViewModel[];
}

export interface RelativeDraftTime {
  readonly key: "Just now" | "{count}d ago" | "{count}h ago" | "{count}m ago";
  readonly values?: Readonly<Record<string, number>>;
}

export function deriveTeammateManagementList(input: {
  readonly channels: readonly Channel[];
  readonly providers: readonly ProviderPreset[];
  readonly teammates: readonly LocalTeammateDraft[];
  readonly templates: readonly AiTeammateTemplate[];
}): TeammateManagementListViewModel {
  const channelById = new Map(input.channels.map((channel) => [channel.id, channel.name]));
  const providerById = new Map(input.providers.map((provider) => [provider.id, provider]));
  const templateById = new Map(input.templates.map((template) => [template.id, template]));
  const activeTeammates = input.teammates.filter((teammate) => !teammate.disabled);
  const rows = activeTeammates.map((draft): TeammateManagementRowViewModel => {
    const providerPresetId = draft.effectiveProviderPresetId ?? draft.providerPresetId;
    const provider = providerPresetId ? providerById.get(providerPresetId) : undefined;
    const ready = Boolean(provider && providerPreflightReady(provider));
    const channelNames = draft.channelIds
      .map((channelId) => channelById.get(channelId))
      .filter((name): name is string => Boolean(name));
    const template = draft.templateId ? templateById.get(draft.templateId) : undefined;
    const modelLabelKey = draft.modelLabel === "No model selected" || draft.modelLabel === "Workspace default is not configured"
      ? draft.modelLabel
      : undefined;
    const status = !ready
      ? { className: "warning" as const, id: "needs-model" as const, labelKey: "Needs model" as const, tone: "warning" as const }
      : draft.hidden
        ? { className: "hidden" as const, id: "hidden" as const, labelKey: "Hidden" as const, tone: "neutral" as const }
        : { className: "ready" as const, id: "ready" as const, labelKey: "Ready teammate" as const, tone: "success" as const };
    return {
      channelNames,
      draft,
      modelLabel: draft.modelLabel,
      modelLabelKey,
      primaryAction: ready ? "open" : "configure-model",
      roleKey: draft.roleKey ?? "custom",
      roleLabelKey: template?.name,
      searchValues: [
        draft.displayName,
        draft.description,
        draft.modelLabel,
        draft.roleKey ?? "custom",
        template?.name ?? "",
        ...channelNames,
      ],
      status,
    };
  });

  return {
    counts: {
      active: rows.length,
      hidden: rows.filter((row) => row.draft.hidden).length,
      needsModel: rows.filter((row) => row.status.id === "needs-model").length,
      ready: rows.filter((row) => row.primaryAction === "open").length,
    },
    rows,
  };
}

export function filterTeammateManagementRows(
  rows: readonly TeammateManagementRowViewModel[],
  input: {
    readonly filter: TeammateManagementFilter;
    readonly localizedSearchValues: (row: TeammateManagementRowViewModel) => readonly string[];
    readonly query: string;
  },
): readonly TeammateManagementRowViewModel[] {
  const query = normalizeSearchValue(input.query);
  return rows.filter((row) => {
    const filterMatches = input.filter === "all"
      || (input.filter === "hidden" && row.draft.hidden)
      || (input.filter === "needs-model" && row.status.id === "needs-model")
      || (input.filter === "ready" && row.primaryAction === "open");
    if (!filterMatches || !query) return filterMatches;
    return [...row.searchValues, ...input.localizedSearchValues(row)]
      .some((value) => normalizeSearchValue(value).includes(query));
  });
}

export function relativeDraftTime(value: string | undefined, now = Date.now()): RelativeDraftTime {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return { key: "Just now" };
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return { key: "Just now" };
  if (minutes < 60) return { key: "{count}m ago", values: { count: minutes } };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { key: "{count}h ago", values: { count: hours } };
  return { key: "{count}d ago", values: { count: Math.round(hours / 24) } };
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}
