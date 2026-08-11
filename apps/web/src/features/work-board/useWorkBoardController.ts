import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkItemView } from "../../lib/work-items.js";
import {
  buildWorkBoardGroups,
  emptyWorkBoardFilters,
  filterAndSortWorkItems,
} from "./work-board-view-models.js";
import type { WorkBoardFilters, WorkBoardOpenIntent, WorkBoardScope, WorkBoardSort } from "./work-board-types.js";

export function useWorkBoardController(input: {
  readonly items: readonly WorkItemView[];
  readonly loading: boolean;
  readonly channelNames: ReadonlyMap<string, string>;
  readonly requestedScope?: WorkBoardScope;
  readonly requestedItemId?: string;
  readonly openIntent?: WorkBoardOpenIntent;
}) {
  const [scope, setScope] = useState<WorkBoardScope>("actionable");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<WorkBoardFilters>(emptyWorkBoardFilters);
  const [sort, setSort] = useState<WorkBoardSort>("updated-desc");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectionOrigin, setSelectionOrigin] = useState<"automatic" | "explicit" | "intent">("automatic");
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [failDialogTargetId, setFailDialogTargetId] = useState("");
  const [failReason, setFailReason] = useState("");
  const [failValidation, setFailValidation] = useState("");
  const appliedScopeRef = useRef<WorkBoardScope | undefined>(undefined);
  const appliedItemRef = useRef("");
  const appliedIntentRef = useRef(0);

  const scopedItems = useMemo(() => filterAndSortWorkItems({
    items: input.items,
    scope,
    query: "",
    filters: emptyWorkBoardFilters,
    sort,
    channelNames: input.channelNames,
  }), [input.channelNames, input.items, scope, sort]);
  const visibleItems = useMemo(() => filterAndSortWorkItems({
    items: input.items,
    scope,
    query,
    filters,
    sort,
    channelNames: input.channelNames,
  }), [filters, input.channelNames, input.items, query, scope, sort]);
  const groups = useMemo(() => buildWorkBoardGroups(visibleItems, scope), [scope, visibleItems]);
  const selectedItem = input.items.find((item) => item.id === selectedItemId);
  const selectedVisible = visibleItems.some((item) => item.id === selectedItemId);
  const selectedHidden = Boolean(selectedItem && !selectedVisible);
  const selectedMissing = Boolean(selectedItemId && !selectedItem && !input.loading);

  useEffect(() => {
    const intent = input.openIntent;
    if (!intent || intent.requestId <= appliedIntentRef.current) return;
    appliedIntentRef.current = intent.requestId;
    setScope(intent.scope);
    setFilters(emptyWorkBoardFilters);
    setQuery("");
    setFilterPopoverOpen(false);
    setSelectedItemId(intent.itemId ?? "");
    setSelectionOrigin(intent.itemId ? "intent" : "automatic");
  }, [input.openIntent]);

  useEffect(() => {
    if (!input.requestedScope || input.requestedScope === appliedScopeRef.current) return;
    appliedScopeRef.current = input.requestedScope;
    setScope(input.requestedScope);
    setSelectedItemId("");
    setSelectionOrigin("automatic");
  }, [input.requestedScope]);

  // Preserve the pre-existing requestedItemId deep-link behavior until AppShell moves to request ids.
  useEffect(() => {
    if (!input.requestedItemId) {
      appliedItemRef.current = "";
      return;
    }
    if (input.requestedItemId === appliedItemRef.current) return;
    appliedItemRef.current = input.requestedItemId;
    setFilters(emptyWorkBoardFilters);
    setQuery("");
    setFilterPopoverOpen(false);
    setSelectedItemId(input.requestedItemId);
    setSelectionOrigin("intent");
  }, [input.requestedItemId]);

  useEffect(() => {
    if (input.loading || selectedItemId || selectionOrigin !== "automatic" || visibleItems.length === 0) return;
    setSelectedItemId(visibleItems[0]?.id ?? "");
  }, [input.loading, selectedItemId, selectionOrigin, visibleItems]);

  function selectScope(nextScope: WorkBoardScope): void {
    setScope(nextScope);
    setSelectedItemId("");
    setSelectionOrigin("automatic");
  }

  function selectItem(itemId: string): void {
    setSelectedItemId(itemId);
    setSelectionOrigin("explicit");
  }

  function updateFilters(patch: Partial<WorkBoardFilters>): void {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function clearFilters(): void {
    setFilters(emptyWorkBoardFilters);
    setQuery("");
  }

  function openFailDialog(itemId: string): void {
    setFilterPopoverOpen(false);
    setFailDialogTargetId(itemId);
    setFailReason("");
    setFailValidation("");
  }

  function closeFailDialog(): void {
    setFailDialogTargetId("");
    setFailValidation("");
  }

  return {
    scope, query, filters, sort, selectedItemId, selectedItem, selectedHidden, selectedMissing,
    scopedItems, visibleItems, groups, filterPopoverOpen, failDialogTargetId, failReason, failValidation,
    setQuery, setSort, selectScope, selectItem, updateFilters, clearFilters, setFilterPopoverOpen,
    setSelectedItemId, openFailDialog, closeFailDialog, setFailReason, setFailValidation,
  };
}
