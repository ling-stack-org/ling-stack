import { Archive, Brain, Eye, MoreHorizontal, Plus, Search, Upload, X } from "lucide-react";
import { useRef, type MouseEvent } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  IconButton,
  InlineFeedback,
  Input,
  InspectorSection,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  StatusIndicator,
} from "../../shared/ui/index.js";
import { TeammateSkillImportDialog } from "./TeammateSkillImportDialog.js";
import { TeammateSkillInspectorDrawer } from "./TeammateSkillInspectorDrawer.js";
import {
  teammateSkillActionLabel,
  teammateSkillFilterLabel,
  type SkillBindingFilter,
  type TeammateSkillRowModel,
} from "./teammate-skills-view-models.js";
import type { TeammateSkillsController } from "./teammate-skills-controller-types.js";

const skillFilters: readonly SkillBindingFilter[] = ["all", "bound", "executable", "blocked", "available"];

export function TeammateSkillsTab({ controller }: { readonly controller: TeammateSkillsController }): JSX.Element {
  const { t } = useI18n();
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const {
    archiveConfirmRow,
    detailsOpen,
    feedback,
    filter,
    importDraft,
    importError,
    importForm,
    importOpen,
    manualSkillId,
    manualSkillIdError,
    mutationBusy,
    mutationKey,
    rows,
    searchQuery,
    selectedRow,
    stats,
    visibleRows,
  } = controller;

  return (
    <section
      className="teammate-skills-panel"
      aria-label={t("Skills")}
      data-ui2-teammate-skills="true"
    >
      <header className="teammate-skills-heading">
        <div>
          <Brain size={17} aria-hidden="true" />
          <h2>{t("Skills")}</h2>
        </div>
        {stats.attention > 0 ? (
          <StatusIndicator compact label={t("{count} need attention", { count: stats.attention })} tone="warning" />
        ) : (
          <StatusIndicator compact label={t("{count} executable", { count: stats.executable })} tone="neutral" />
        )}
      </header>

      <div className="teammate-skill-summary" aria-label={t("Skill execution summary")}>
        <SummaryItem label={t("Bound")} stat="bound" value={stats.bound} />
        <SummaryItem label={t("Executable")} stat="executable" value={stats.executable} />
        <SummaryItem label={t("Needs attention")} stat="attention" value={stats.attention} tone={stats.attention > 0 ? "warning" : "neutral"} />
      </div>

      <div className="teammate-skill-toolbar">
        <Input
          aria-label={t("Search skills or tools")}
          containerClassName="teammate-skill-search"
          prefix={<Search size={15} aria-hidden="true" />}
          placeholder={t("Search skills or tools")}
          value={searchQuery}
          onChange={(event) => controller.setSearchQuery(event.target.value)}
        />
        <Select
          aria-label={t("Skill filters")}
          className="teammate-skill-filter"
          value={filter}
          onChange={(event) => controller.setFilter(event.target.value as SkillBindingFilter)}
        >
          {skillFilters.map((item) => (
            <option key={item} value={item}>{teammateSkillFilterLabel(item, t)}</option>
          ))}
        </Select>
        <Button
          leadingIcon={<Upload />}
          size="sm"
          variant="secondary"
          disabled={mutationBusy}
          onClick={() => controller.setImportOpen(true)}
        >
          {t("Import skill")}
        </Button>
      </div>

      {feedback ? <InlineFeedback className="teammate-skills-feedback" tone="danger">{feedback}</InlineFeedback> : null}

      {rows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-skills-empty"
          icon={<Brain />}
          title={t("No skills available")}
          description={t("Import a skill to make it available for this teammate.")}
          action={(
            <Button leadingIcon={<Upload />} size="sm" onClick={() => controller.setImportOpen(true)}>
              {t("Import skill")}
            </Button>
          )}
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-skills-empty"
          icon={<Search />}
          title={t("No skills match these filters")}
          action={<Button size="sm" variant="secondary" onClick={controller.clearFilters}>{t("Clear filters")}</Button>}
        />
      ) : (
        <div className="teammate-skill-list" role="listbox" aria-label={t("Skills")}>
          {visibleRows.map((row) => (
            <SkillRow
              key={row.id}
              mutationBusy={mutationBusy}
              mutationKey={mutationKey}
              row={row}
              onOpenDetails={(skillId, trigger) => {
                detailReturnFocusRef.current = trigger;
                controller.openDetails(skillId);
              }}
              onRemoveBinding={controller.removeBinding}
              onRequestArchive={controller.requestArchive}
              onToggleBinding={controller.toggleBinding}
            />
          ))}
        </div>
      )}

      <InspectorSection
        className="teammate-skill-advanced-binding"
        title={t("Advanced binding")}
        summary={t("Bind by Skill ID")}
      >
        <div className="teammate-skill-advanced-binding-body">
          <Field label={t("Skill id")} error={manualSkillIdError || undefined}>
            <Input
              value={manualSkillId}
              onChange={(event) => controller.setManualSkillId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void controller.bindManualSkill();
                }
              }}
            />
          </Field>
          <Button
            leadingIcon={<Plus />}
            size="sm"
            variant="secondary"
            loading={mutationKey.startsWith("manual:")}
            loadingLabel={t("Saving...")}
            disabled={mutationBusy}
            onClick={() => void controller.bindManualSkill()}
          >
            {t("Bind")}
          </Button>
        </div>
      </InspectorSection>

      <TeammateSkillInspectorDrawer
        mutationKey={mutationKey}
        open={detailsOpen}
        returnFocusRef={detailReturnFocusRef}
        row={selectedRow}
        onOpenChange={(open) => {
          if (!open) controller.closeDetails();
        }}
        onRemoveBinding={controller.removeBinding}
        onToggleBinding={controller.toggleBinding}
      />

      <TeammateSkillImportDialog
        draft={importDraft}
        error={importError}
        form={importForm}
        mutationKey={mutationKey}
        open={importOpen}
        onFormChange={controller.updateImportForm}
        onOpenChange={controller.setImportOpen}
        onPreview={controller.previewImport}
        onPublish={controller.publishImport}
      />

      <Dialog
        busy={Boolean(archiveConfirmRow && mutationKey === `archive:${archiveConfirmRow.id}`)}
        open={Boolean(archiveConfirmRow)}
        onOpenChange={(open) => {
          if (!open) controller.requestArchive();
        }}
      >
        <DialogContent className="teammate-skill-archive-dialog" size="sm">
          <DialogHeader closeLabel={t("Close")} title={t("Archive skill?")} description={archiveConfirmRow?.displayName} />
          <DialogBody>
            <InlineFeedback tone="warning">
              {t("Archiving removes this custom Skill from the Registry. Existing runtime history is not deleted.")}
            </InlineFeedback>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => controller.requestArchive()} disabled={mutationBusy}>{t("Cancel")}</Button>
            <Button
              leadingIcon={<Archive />}
              variant="danger"
              loading={Boolean(archiveConfirmRow && mutationKey === `archive:${archiveConfirmRow.id}`)}
              loadingLabel={t("Archiving")}
              disabled={mutationBusy}
              onClick={() => void controller.archiveSkillFromRegistry()}
            >
              {t("Archive skill")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SummaryItem({
  label,
  stat,
  tone = "neutral",
  value,
}: {
  readonly label: string;
  readonly stat: "attention" | "bound" | "executable";
  readonly tone?: "neutral" | "warning";
  readonly value: number;
}): JSX.Element {
  return (
    <span data-stat={stat} data-tone={tone}>
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

function SkillRow({
  mutationBusy,
  mutationKey,
  row,
  onOpenDetails,
  onRemoveBinding,
  onRequestArchive,
  onToggleBinding,
}: {
  readonly mutationBusy: boolean;
  readonly mutationKey: string;
  readonly row: TeammateSkillRowModel;
  readonly onOpenDetails: (skillId: string, trigger: HTMLElement) => void;
  readonly onRemoveBinding: (skillId: string) => void | Promise<void>;
  readonly onRequestArchive: (skillId: string) => void;
  readonly onToggleBinding: (skillId: string) => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const primaryMutationKey = `${row.primaryAction}:${row.id}`;
  const stopRowClick = (event: MouseEvent<HTMLElement>): void => event.stopPropagation();
  return (
    <DataRow
      compact
      className="teammate-management-skill-row"
      data-skill-id={row.id}
      data-ui2-teammate-skill-row="true"
      identity={(
        <span className="teammate-skill-row-identity">
          <strong title={row.displayName}>{row.displayName}</strong>
          <small title={row.summary}>{row.summary}</small>
        </span>
      )}
      onClick={(event) => onOpenDetails(row.id, event.currentTarget)}
      status={(
        <span className="teammate-skill-row-status">
          <StatusIndicator compact label={row.status.label} tone={row.status.tone} />
          {row.sourceState.attention ? <small>{row.sourceState.label}</small> : null}
        </span>
      )}
      summary={(
        <span className="teammate-skill-row-summary">
          <span>{row.sourceLabel}</span>
          <small>{t("{count} required tools", { count: row.toolCount })}</small>
        </span>
      )}
      actions={(
        <div className="teammate-skill-row-actions" onClick={stopRowClick} onKeyDown={(event) => event.stopPropagation()}>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={row.primaryAction === "disable" ? <X /> : <Plus />}
            loading={mutationKey === primaryMutationKey}
            loadingLabel={t("Saving...")}
            disabled={mutationBusy}
            onClick={() => void onToggleBinding(row.id)}
          >
            {teammateSkillActionLabel(row.primaryAction, t)}
          </Button>
          <IconButton
            icon={Eye}
            label={t("View skill details")}
            disabled={mutationBusy}
            onClick={(event) => onOpenDetails(row.id, event.currentTarget)}
          />
          {row.canRemove || row.canArchive ? (
            <Menu>
              <MenuTrigger asChild>
                <IconButton
                  icon={MoreHorizontal}
                  label={t("More actions for {name}", { name: row.displayName })}
                  disabled={mutationBusy}
                />
              </MenuTrigger>
              <MenuContent align="end">
                {row.canRemove ? (
                  <MenuItem onSelect={() => void onRemoveBinding(row.id)}>{t("Remove from teammate")}</MenuItem>
                ) : null}
                {row.canRemove && row.canArchive ? <MenuSeparator /> : null}
                {row.canArchive ? (
                  <MenuItem tone="danger" onSelect={() => onRequestArchive(row.id)}>{t("Archive skill")}</MenuItem>
                ) : null}
              </MenuContent>
            </Menu>
          ) : null}
        </div>
      )}
    />
  );
}
