import { Search, Sparkles } from "lucide-react";
import { useRef, type MouseEvent } from "react";
import { useI18n } from "../../i18n.js";
import {
  Badge,
  Button,
  DataRow,
  EmptyState,
  InlineFeedback,
  Input,
  OverlayScrollArea,
  Select,
  Switch,
} from "../../shared/ui/index.js";
import { TeammateSkillInspectorDrawer } from "./TeammateSkillInspectorDrawer.js";
import {
  teammateSkillFilterLabel,
  teammateSkillNeedsAttention,
  type SkillBindingFilter,
  type TeammateSkillRowModel,
} from "./teammate-skills-view-models.js";
import type { TeammateSkillsController } from "./teammate-skills-controller-types.js";

const skillFilters: readonly SkillBindingFilter[] = ["all", "using", "unused", "attention"];

export function TeammateSkillsTab({
  controller,
  onOpenSkillLibrary,
}: {
  readonly controller: TeammateSkillsController;
  readonly onOpenSkillLibrary?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const {
    detailsOpen,
    feedback,
    filter,
    mutationBusy,
    mutationKey,
    rows,
    searchQuery,
    selectedRow,
    visibleRows,
  } = controller;

  return (
    <section className="teammate-skills-panel" aria-label={t("Skills")} data-ui2-teammate-skills="true">
      <div className="teammate-skill-toolbar">
        <Input
          aria-label={t("Search skills or purposes")}
          containerClassName="teammate-skill-search"
          prefix={<Search size={15} aria-hidden="true" />}
          placeholder={t("Search skills or purposes")}
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
      </div>

      {feedback ? <InlineFeedback className="teammate-skills-feedback" tone="danger">{feedback}</InlineFeedback> : null}

      {rows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-skills-empty"
          icon={<Sparkles />}
          title={t("No skills available")}
          action={onOpenSkillLibrary ? (
            <Button size="sm" variant="secondary" onClick={onOpenSkillLibrary}>{t("Open skill library")}</Button>
          ) : undefined}
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
        <div className="teammate-skill-list-shell">
          <div className="teammate-skill-list-header" aria-hidden="true">
            <span>{t("Skill")}</span>
            <span>{t("Description")}</span>
            <span>{t("Use")}</span>
          </div>
          <OverlayScrollArea
            className="teammate-skill-scroll-area"
            viewportClassName="teammate-skill-list"
          >
            <div role="list" aria-label={t("Skills")}>
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
                  onToggleBinding={controller.toggleBinding}
                />
              ))}
            </div>
          </OverlayScrollArea>
        </div>
      )}

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
    </section>
  );
}

function SkillRow({
  mutationBusy,
  mutationKey,
  row,
  onOpenDetails,
  onToggleBinding,
}: {
  readonly mutationBusy: boolean;
  readonly mutationKey: string;
  readonly row: TeammateSkillRowModel;
  readonly onOpenDetails: (skillId: string, trigger: HTMLElement) => void;
  readonly onToggleBinding: (skillId: string) => void | Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const stopRowClick = (event: MouseEvent<HTMLElement>): void => event.stopPropagation();
  const needsAttention = teammateSkillNeedsAttention(row);
  return (
    <DataRow
      compact
      className="teammate-management-skill-row"
      data-skill-id={row.id}
      data-ui2-teammate-skill-row="true"
      role="listitem"
      identity={(
        <span className="teammate-skill-row-title">
          <strong title={row.displayName}>{row.displayName}</strong>
          {needsAttention ? (
            <Badge className="teammate-skill-attention-badge" tone="warning" variant="outline">
              {t("Needs attention")}
            </Badge>
          ) : null}
        </span>
      )}
      summary={<span className="teammate-skill-row-description" title={row.summary}>{row.summary}</span>}
      onClick={(event) => onOpenDetails(row.id, event.currentTarget)}
      actions={(
        <span className="teammate-skill-row-use" onClick={stopRowClick} onKeyDown={(event) => event.stopPropagation()}>
          <Switch
            aria-label={t("Use skill for teammate: {name}", { name: row.displayName })}
            checked={Boolean(row.binding?.enabled)}
            disabled={mutationBusy}
            loading={mutationKey.endsWith(`:${row.id}`)}
            onCheckedChange={() => void onToggleBinding(row.id)}
          />
        </span>
      )}
    />
  );
}
