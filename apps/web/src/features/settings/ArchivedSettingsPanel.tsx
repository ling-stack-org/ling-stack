import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import { ArchivedDeleteDialog } from "./ArchivedDeleteDialog.js";
import { ArchivedErrorFeedback } from "./ArchivedErrorFeedback.js";
import { ArchivedItemList } from "./ArchivedItemList.js";
import { ArchivedItemsToolbar } from "./ArchivedItemsToolbar.js";
import type { ArchivedSettingsControllerActions, ArchivedSettingsControllerState } from "./useArchivedSettingsController.js";
import {
  archivedCategoryCount,
  archivedCategoryDefinitions,
  createArchivedDeleteTarget,
  createArchivedRows,
  filterArchivedRows,
  readArchivedCategoryPreference,
  writeArchivedCategoryPreference,
  type ArchivedCategoryId,
  type ArchivedDeleteTarget,
  type ArchivedItemRowViewModel,
} from "./archived-items-view-models.js";

export function ArchivedSettingsPanel({
  state,
  actions,
}: {
  readonly state: ArchivedSettingsControllerState;
  readonly actions: ArchivedSettingsControllerActions;
}): JSX.Element {
  const { t } = useI18n();
  const [activeCategory, setActiveCategory] = useState<ArchivedCategoryId>(readArchivedCategoryPreference);
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ArchivedDeleteTarget>();
  const deleteReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const projectionInput = state;
  const category = archivedCategoryDefinitions.find((item) => item.id === activeCategory) ?? archivedCategoryDefinitions[0];
  const rows = filterArchivedRows(createArchivedRows(activeCategory, projectionInput), searchQuery, t);
  const counts = Object.fromEntries(
    archivedCategoryDefinitions.map((item) => [item.id, archivedCategoryCount(item.id, projectionInput)]),
  ) as Record<ArchivedCategoryId, number>;
  const deleteError = deleteTarget && state.actionError?.actionId === deleteTarget.actionId
    ? state.actionError
    : undefined;
  const listActionError = state.actionError?.actionId.endsWith(":restore")
    ? state.actionError
    : undefined;

  useEffect(() => {
    writeArchivedCategoryPreference(activeCategory);
  }, [activeCategory]);

  const changeCategory = (categoryId: ArchivedCategoryId): void => {
    setActiveCategory(categoryId);
    setSearchQuery("");
    setDeleteTarget(undefined);
    actions.clearActionError();
  };

  const restore = async (row: ArchivedItemRowViewModel): Promise<void> => {
    actions.clearActionError();
    switch (row.source.kind) {
      case "conversation": await actions.restoreConversation(row.source.item.id); break;
      case "teammate": await actions.restoreTeammate(row.source.item.id); break;
      case "channel": await actions.restoreChannel(row.source.item.id); break;
      case "branch": await actions.restoreBranch(row.source.item); break;
    }
  };

  const openDelete = (row: ArchivedItemRowViewModel, trigger: HTMLButtonElement): void => {
    deleteReturnFocusRef.current = trigger;
    actions.clearActionError();
    setDeleteTarget(createArchivedDeleteTarget(row));
  };

  const closeDelete = (): void => {
    if (state.actionId) return;
    setDeleteTarget(undefined);
    actions.clearActionError();
  };

  const confirmDelete = async (): Promise<boolean> => {
    if (!deleteTarget) return false;
    const deleted = deleteTarget.source.kind === "conversation"
      ? await actions.deleteConversation(deleteTarget.source.item)
      : deleteTarget.source.kind === "teammate"
        ? await actions.deleteTeammate(deleteTarget.source.item)
        : deleteTarget.source.kind === "channel"
          ? await actions.deleteChannel(deleteTarget.source.item)
          : await actions.deleteBranch(deleteTarget.source.item);
    if (deleted) {
      setDeleteTarget(undefined);
      actions.clearActionError();
    }
    return deleted;
  };

  return (
    <section
      className="panel settings-panel archived-items-settings-panel"
      data-ui2-archived-items=""
      aria-label={t("Archived items")}
    >
      {state.loadError ? <ArchivedErrorFeedback className="archived-items-load-feedback" feedback={state.loadError} /> : null}
      <ArchivedItemsToolbar
        activeCategory={activeCategory}
        counts={counts}
        query={searchQuery}
        searchInputRef={searchInputRef}
        onCategoryChange={changeCategory}
        onQueryChange={setSearchQuery}
      />
      <ArchivedItemList
        actionError={listActionError}
        actionId={state.actionId}
        emptyLabel={searchQuery.trim() ? t("No matching archived items") : t(category.emptyLabelKey)}
        isLoading={state.isLoading}
        label={t(category.labelKey)}
        rows={rows}
        onDelete={openDelete}
        onRestore={(row) => void restore(row)}
      />
      <ArchivedDeleteDialog
        busy={Boolean(deleteTarget && state.actionId === deleteTarget.actionId)}
        error={deleteError}
        fallbackFocusRef={searchInputRef}
        returnFocusRef={deleteReturnFocusRef}
        target={deleteTarget}
        onClose={closeDelete}
        onConfirm={confirmDelete}
      />
    </section>
  );
}
