import { useEffect, useMemo, useRef } from "react";
import { useWorkBoardEvidence } from "../../domains/work-items/use-work-board-evidence.js";
import { useWorkBoardSourceProjection } from "../../domains/work-items/use-work-board-source-projection.js";
import { useI18n } from "../../i18n.js";
import { useFocusRevalidationToken } from "../../shared/hooks/use-focus-revalidation-token.js";
import { buildWorkItemViews, type WorkItemView } from "../../lib/work-items.js";
import { useLingToast } from "../../shared/ui/index.js";
import { WorkBoardFailDialog } from "./WorkBoardFailDialog.js";
import { WorkBoardHeader } from "./WorkBoardHeader.js";
import { WorkBoardInspector } from "./WorkBoardInspector.js";
import { WorkBoardList } from "./WorkBoardList.js";
import { WorkBoardToolbar } from "./WorkBoardToolbar.js";
import type { GlobalWorkBoardPageProps, WorkBoardActionResult } from "./work-board-page-types.js";
import { countActiveFilters, readWorkBoardStats } from "./work-board-view-models.js";
import type { WorkBoardActionFailure, WorkBoardMutation, WorkBoardScope } from "./work-board-types.js";
import { useWorkBoardController } from "./useWorkBoardController.js";

export type { WorkBoardScope } from "./work-board-types.js";

export function GlobalWorkBoardPage(props: GlobalWorkBoardPageProps): JSX.Element {
  const { t } = useI18n();
  const focusRevalidationToken = useFocusRevalidationToken();
  const { showToast } = useLingToast();
  const channelNames = useMemo(() => new Map(props.channels.map((channel) => [channel.id, channel.name])), [props.channels]);
  const projectionCwd = props.workspaceCwd?.trim() || props.runs.find((run) => run.cwd?.trim())?.cwd;
  const source = useWorkBoardSourceProjection({ cwd: projectionCwd, channels: props.channels });
  const fallbackItems = useMemo(() => source.active ? [] : buildWorkItemViews({
    tasks: props.tasks, runs: props.runs, approvals: props.approvals, workflowSteps: props.workflowSteps,
    externalActions: props.externalActionDetails, externalWorkCiTriage: props.externalWorkCiTriage,
    artifactsByRun: props.artifactsByRun, durableWorkItems: props.durableWorkItems,
  }), [props.approvals, props.artifactsByRun, props.durableWorkItems, props.externalActionDetails, props.externalWorkCiTriage, props.runs, props.tasks, props.workflowSteps, source.active]);
  const items = source.active ? source.items : fallbackItems;
  const loading = source.active ? source.loading && items.length === 0 : Boolean(props.loading);
  const freshness = source.active ? source.freshness : "partial";
  const controller = useWorkBoardController({
    items, loading, channelNames, requestedScope: props.requestedScope, requestedItemId: props.requestedItemId, openIntent: props.openIntent,
  });
  const evidence = useWorkBoardEvidence(projectionCwd, controller.selectedItemId);
  const busyByWorkItemId = useMemo(() => {
    const next = new Map<string, WorkBoardMutation>(props.busyByWorkItemId ?? []);
    if (!props.busyByWorkItemId && props.busyWorkItemId) next.set(props.busyWorkItemId, "claim");
    const routingIds = props.routingByExternalWorkId ?? (props.routingExternalWorkId ? new Set([props.routingExternalWorkId]) : undefined);
    if (routingIds) {
      for (const item of items) {
        if (item.externalWorkId && routingIds.has(item.externalWorkId)) next.set(item.id, "route");
      }
    }
    return next;
  }, [items, props.busyByWorkItemId, props.busyWorkItemId, props.routingByExternalWorkId, props.routingExternalWorkId]);
  const stats = useMemo(() => readWorkBoardStats(items), [items]);
  const sourceOptions = useMemo(() => [...new Set(controller.scopedItems.map((item) => item.sourceType))].sort(), [controller.scopedItems]);
  const waitingOptions = useMemo(() => [...new Set(controller.scopedItems.map((item) => item.waitingReason).filter((value): value is NonNullable<typeof value> => Boolean(value)))].sort(), [controller.scopedItems]);
  const ownerOptions = useMemo(() => [...new Set(items.map((item) => item.assigneeTeammateId).filter((value): value is string => Boolean(value)))].sort(), [items]);
  const selected = controller.selectedItem;
  const selectedBusy = selected ? busyByWorkItemId.get(selected.id) : undefined;
  const selectedFailure = selected ? readActionFailure(props.failureByWorkItemId, selected) : undefined;
  const failTarget = items.find((item) => item.id === controller.failDialogTargetId);
  const pendingLegacyFailRef = useRef("");
  const failReturnFocusRef = useRef<HTMLElement | null>(null);
  const postMutationFocusItemIdRef = useRef("");
  const pendingDurableMutationsRef = useRef(new Map<string, string | undefined>());
  const durableRevision = useMemo(() => (props.durableWorkItems ?? []).map((item) => `${item.id}:${item.status}:${item.updatedAt}:${item.claim?.heartbeatAt ?? ""}`).join("|"), [props.durableWorkItems]);
  const previousDurableRevisionRef = useRef(durableRevision);

  useEffect(() => {
    const previous = previousDurableRevisionRef.current;
    previousDurableRevisionRef.current = durableRevision;
    if (source.active && previous !== durableRevision && pendingDurableMutationsRef.current.size > 0) {
      const completed = [...pendingDurableMutationsRef.current.entries()];
      pendingDurableMutationsRef.current.clear();
      const focusItemId = postMutationFocusItemIdRef.current;
      postMutationFocusItemIdRef.current = "";
      void source.refresh().finally(() => {
        if (focusItemId) restoreWorkItemRowFocus(focusItemId);
      });
      for (const [itemId, message] of completed) if (message) showToast({ message, scope: `work-item:${itemId}:mutation`, tone: "success" });
    }
  }, [durableRevision, showToast, source.active, source.refresh]);

  useEffect(() => {
    for (const itemId of pendingDurableMutationsRef.current.keys()) {
      if (props.failureByWorkItemId?.has(itemId) || props.blockerByWorkItemId?.has(itemId)) {
        pendingDurableMutationsRef.current.delete(itemId);
        if (postMutationFocusItemIdRef.current === itemId) postMutationFocusItemIdRef.current = "";
      }
    }
  }, [props.blockerByWorkItemId, props.failureByWorkItemId]);

  useEffect(() => {
    const pendingId = pendingLegacyFailRef.current;
    if (!pendingId) return;
    const current = items.find((item) => item.id === pendingId);
    if (current?.status === "blocked" && !busyByWorkItemId.has(pendingId)) {
      pendingLegacyFailRef.current = "";
      controller.closeFailDialog();
    }
  }, [busyByWorkItemId, items]);

  function refresh(): void {
    if (source.active) void source.refresh(); else void props.onRefresh();
  }

  useEffect(() => {
    if (focusRevalidationToken === 0) return;
    refresh();
    // The source projection owns retained data and scoped failure state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRevalidationToken]);

  async function runMutation(action: WorkBoardActionResult | undefined, successMessage?: string, refreshSource = false): Promise<boolean> {
    if (action === undefined) return false;
    const asynchronous = typeof (action as Promise<unknown>)?.then === "function";
    const result = asynchronous ? await action : action;
    if (result === false) return false;
    if (source.active && asynchronous && refreshSource) await source.refresh();
    if (successMessage && asynchronous) showToast({ message: successMessage, scope: `work-item:${selected?.id ?? "unknown"}:${successMessage}`, tone: "success" });
    return true;
  }

  async function runDurableMutation(itemId: string, action: WorkBoardActionResult | undefined, successMessage?: string): Promise<boolean> {
    pendingDurableMutationsRef.current.set(itemId, successMessage);
    if (action === undefined) return false;
    const succeeded = await runMutation(action);
    if (!succeeded) pendingDurableMutationsRef.current.delete(itemId);
    return succeeded;
  }

  const openTask = (id: string): void => { void props.onOpenTask(id); };
  const openRun = (id: string): void => { void props.onOpenRun(id); };
  const openApproval = (id: string): void => { void props.onOpenApproval(id); };
  const openChannel = (id: string): void => { void props.onOpenChannel(id); };
  const claim = (id: string): void => { void runDurableMutation(id, props.onClaimWorkItem?.(id)); };

  return (
    <section className="work-board-page" aria-labelledby="global-work-board-title" data-source-active={source.active} data-source-freshness={freshness}>
      <WorkBoardHeader stats={stats} freshness={freshness} />
      <WorkBoardToolbar
        scope={controller.scope} query={controller.query} filters={controller.filters} sort={controller.sort} channels={props.channels}
        sourceOptions={sourceOptions} waitingOptions={waitingOptions} ownerOptions={ownerOptions} popoverOpen={controller.filterPopoverOpen}
        onScopeChange={controller.selectScope} onQueryChange={controller.setQuery} onFiltersChange={controller.updateFilters}
        onSortChange={controller.setSort} onClearFilters={controller.clearFilters} onPopoverOpenChange={controller.setFilterPopoverOpen}
      />
      <main className="work-board-content">
        <WorkBoardList
          items={controller.visibleItems} totalCount={items.length} scopedCount={controller.scopedItems.length} groups={controller.groups}
          selectedItemId={controller.selectedItemId} scope={controller.scope} loading={loading} freshness={freshness} issues={source.active ? source.issues : []}
          filtered={Boolean(controller.query || countActiveFilters(controller.filters))} channelNames={channelNames} busyByWorkItemId={busyByWorkItemId}
          onSelect={controller.selectItem} onRefresh={refresh} onClearFilters={controller.clearFilters} onChangeScope={controller.selectScope}
          onOpenTask={openTask} onOpenRun={openRun} onOpenApproval={openApproval} onOpenChannel={openChannel} onClaim={props.onClaimWorkItem ? claim : undefined}
          onHeartbeat={props.onHeartbeatWorkItem ? (id, token) => { void runDurableMutation(id, props.onHeartbeatWorkItem?.(id, token)); } : undefined}
        />
        <WorkBoardInspector
          item={selected} selectedHidden={controller.selectedHidden} selectedMissing={controller.selectedMissing} channels={props.channels}
          channelName={selected?.channelId ? channelNames.get(selected.channelId) : undefined} busy={selectedBusy}
          failure={selectedFailure} blocker={selected ? props.blockerByWorkItemId?.get(selected.id) : undefined}
          evidence={evidence.read(selected)} onClearFilters={controller.clearFilters} onClearSelection={() => controller.setSelectedItemId("")} onRefresh={refresh}
          onOpenTask={openTask} onOpenRun={openRun} onOpenApproval={openApproval} onOpenChannel={openChannel}
          onRoute={props.onRouteExternalWork ? (externalId, channelId) => { void runMutation(props.onRouteExternalWork?.(externalId, channelId), t("Work routed"), true); } : undefined}
          onClaim={props.onClaimWorkItem ? claim : undefined}
          onHeartbeat={props.onHeartbeatWorkItem ? (id, token) => { void runDurableMutation(id, props.onHeartbeatWorkItem?.(id, token)); } : undefined}
          onRelease={props.onReleaseWorkItem ? (id, token) => { void runDurableMutation(id, props.onReleaseWorkItem?.(id, token)); } : undefined}
          onComplete={props.onCompleteWorkItem ? (id, token) => { void runDurableMutation(id, props.onCompleteWorkItem?.(id, token), t("Work completed")); } : undefined}
          onOpenFail={(id, trigger) => { failReturnFocusRef.current = trigger; controller.openFailDialog(id); }} onLoadEvidence={(item) => { void evidence.load(item); }}
        />
      </main>
      <WorkBoardFailDialog
        item={failTarget} open={Boolean(failTarget)} reason={controller.failReason} validation={controller.failValidation}
        busy={Boolean(failTarget && busyByWorkItemId.has(failTarget.id))} failure={failTarget ? props.failureByWorkItemId?.get(failTarget.id) : undefined}
        returnFocusRef={failReturnFocusRef}
        onReasonChange={controller.setFailReason} onValidationChange={controller.setFailValidation} onClose={controller.closeFailDialog}
        onConfirm={async (reason) => {
          if (!failTarget?.claim?.token || !props.onFailWorkItem) return false;
          postMutationFocusItemIdRef.current = failTarget.id;
          const result = props.onFailWorkItem(failTarget.id, failTarget.claim.token, reason);
          if (result === undefined) {
            pendingDurableMutationsRef.current.set(failTarget.id, t("Work marked failed"));
            pendingLegacyFailRef.current = failTarget.id;
            return false;
          }
          const succeeded = await runDurableMutation(failTarget.id, result, t("Work marked failed"));
          if (!succeeded) postMutationFocusItemIdRef.current = "";
          return succeeded;
        }}
      />
    </section>
  );
}

function readActionFailure(
  failures: GlobalWorkBoardPageProps["failureByWorkItemId"],
  item: WorkItemView,
): WorkBoardActionFailure | undefined {
  return failures?.get(item.id) ?? (item.externalWorkId ? failures?.get(item.externalWorkId) : undefined);
}

function restoreWorkItemRowFocus(itemId: string): void {
  requestAnimationFrame(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body && activeElement.isConnected) return;
    document.querySelector<HTMLElement>(`[data-work-item-id="${CSS.escape(itemId)}"]`)?.focus();
  });
}
