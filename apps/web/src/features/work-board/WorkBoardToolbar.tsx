import { ListFilter, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { workItemStatusLabel, workItemStatusOrder, type WorkItemSourceType, type WorkItemView, type WorkItemWaitingReason } from "../../lib/work-items.js";
import { Badge, Button, Field, IconButton, Input, Popover, PopoverContent, PopoverTrigger, Select, Tabs, TabsList, TabsTrigger } from "../../shared/ui/index.js";
import { countActiveFilters, workBoardScopeLabel, workBoardScopeOrder, workBoardSortLabel, workBoardSortOrder } from "./work-board-view-models.js";
import type { WorkBoardFilters, WorkBoardScope, WorkBoardSort } from "./work-board-types.js";

export function WorkBoardToolbar(props: {
  readonly scope: WorkBoardScope;
  readonly query: string;
  readonly filters: WorkBoardFilters;
  readonly sort: WorkBoardSort;
  readonly channels: readonly { readonly id: string; readonly name: string }[];
  readonly sourceOptions: readonly WorkItemSourceType[];
  readonly waitingOptions: readonly WorkItemWaitingReason[];
  readonly ownerOptions: readonly string[];
  readonly popoverOpen: boolean;
  readonly onScopeChange: (scope: WorkBoardScope) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onFiltersChange: (patch: Partial<WorkBoardFilters>) => void;
  readonly onSortChange: (sort: WorkBoardSort) => void;
  readonly onClearFilters: () => void;
  readonly onPopoverOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const activeCount = countActiveFilters(props.filters);
  return (
    <div className="work-board-toolbar">
      <Tabs value={props.scope} onValueChange={(value) => props.onScopeChange(value as WorkBoardScope)}>
        <TabsList aria-label={t("Work board views")} className="work-board-scope-tabs" size="sm">
          {workBoardScopeOrder.map((scope) => <TabsTrigger aria-pressed={props.scope === scope} key={scope} role="button" value={scope}>{t(workBoardScopeLabel(scope))}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="work-board-toolbar-controls">
        <Input
          aria-label={t("Search work")}
          containerClassName="work-board-search"
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder={t("Search work")}
          prefix={<Search aria-hidden="true" size={15} />}
          type="search"
          value={props.query}
        />
        <span className="work-board-filter-trigger">
          <Popover open={props.popoverOpen} onOpenChange={props.onPopoverOpenChange}>
            <PopoverTrigger asChild>
              <IconButton icon={ListFilter} label={t("Filter work")} pressed={props.popoverOpen} variant="secondary" />
            </PopoverTrigger>
            <PopoverContent align="end" className="work-board-filter-popover" collisionPadding={12} size="lg">
            <div className="work-board-filter-fields">
              <FilterSelect label={t("Channel")} value={props.filters.channelId} onChange={(channelId) => props.onFiltersChange({ channelId })} options={props.channels.map((channel) => [channel.id, channel.name])} />
              <FilterSelect label={t("Status")} value={props.filters.status} onChange={(status) => props.onFiltersChange({ status: status as WorkBoardFilters["status"] })} options={workItemStatusOrder.map((status) => [status, t(workItemStatusLabel(status))])} />
              <FilterSelect label={t("Source")} value={props.filters.source} onChange={(source) => props.onFiltersChange({ source: source as WorkBoardFilters["source"] })} options={props.sourceOptions.map((source) => [source, t(source)])} />
              <FilterSelect label={t("Owner")} value={props.filters.owner} onChange={(owner) => props.onFiltersChange({ owner: owner as WorkBoardFilters["owner"] })} options={[["unassigned", t("Unassigned")] as const, ["claimed", t("Claimed")] as const, ...props.ownerOptions.map((owner) => [`teammate:${owner}`, owner] as const)]} />
              <FilterSelect label={t("Waiting reason")} value={props.filters.waitingReason} onChange={(waitingReason) => props.onFiltersChange({ waitingReason: waitingReason as WorkBoardFilters["waitingReason"] })} options={props.waitingOptions.map((reason) => [reason, t(reason)])} />
              <FilterSelect label={t("Priority")} value={props.filters.priority} onChange={(priority) => props.onFiltersChange({ priority: priority as WorkBoardFilters["priority"] })} options={(["urgent", "high", "normal", "low"] satisfies WorkItemView["priority"][]).map((priority) => [priority, t(priority)])} />
            </div>
            <Button size="sm" variant="ghost" onClick={props.onClearFilters}>{t("Clear filters")}</Button>
            </PopoverContent>
          </Popover>
          {activeCount > 0 ? <Badge className="work-board-filter-count" aria-label={t("{count} active filters", { count: activeCount })}>{activeCount}</Badge> : null}
        </span>
        <Select aria-label={t("Sort work")} containerClassName="work-board-sort" size="sm" value={props.sort} onChange={(event) => props.onSortChange(event.target.value as WorkBoardSort)}>
          {workBoardSortOrder.map((sort) => <option key={sort} value={sort}>{t(workBoardSortLabel(sort))}</option>)}
        </Select>
      </div>
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { readonly label: string; readonly value: string; readonly options: readonly (readonly [string, string])[]; readonly onChange: (value: string) => void }): React.JSX.Element {
  const { t } = useI18n();
  return <Field label={label}><Select size="sm" value={value} onChange={(event) => onChange(event.target.value)}><option value="">{t("All")}</option>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</Select></Field>;
}
