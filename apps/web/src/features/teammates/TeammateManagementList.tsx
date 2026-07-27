import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import {
  Bot,
  EyeOff,
  MoreHorizontal,
  Pin,
  PinOff,
  PlugZap,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  EmptyState,
  IconButton,
  InlineFeedback,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  Skeleton,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { Channel, ProviderPreset } from "../../types.js";
import { roleLabel } from "./helpers.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import { relativeDraftTime, type TeammateManagementRowViewModel } from "./teammate-management-list-view-models.js";
import type { LocalTeammateDraft } from "./types.js";
import { useTeammateManagementListController } from "./useTeammateManagementListController.js";

export function TeammateManagementList({
  channels,
  cwd,
  isLoading,
  loadErrorMessage,
  actionErrorMessagesByTeammateId,
  onCreate,
  onOpenCouncils,
  onOpenProviders,
  onOpenTeammate,
  onRefresh,
  onRemoveTeammate,
  onToggleTeammateHidden,
  onToggleTeammatePinned,
  providers,
  settingsToolMode,
  teammates,
  templates,
}: {
  readonly channels: readonly Channel[];
  readonly cwd: string;
  readonly isLoading: boolean;
  readonly loadErrorMessage?: string;
  readonly actionErrorMessagesByTeammateId: Readonly<Record<string, string>>;
  readonly onCreate: () => void;
  readonly onOpenCouncils?: () => void;
  readonly onOpenProviders: () => void;
  readonly onOpenTeammate?: (teammateId: string) => void;
  readonly onRefresh: () => void;
  readonly onRemoveTeammate: (teammateId: string) => void;
  readonly onToggleTeammateHidden: (teammateId: string) => void;
  readonly onToggleTeammatePinned: (teammateId: string) => void;
  readonly providers: readonly ProviderPreset[];
  readonly settingsToolMode: boolean;
  readonly teammates: readonly LocalTeammateDraft[];
  readonly templates: readonly AiTeammateTemplate[];
}): JSX.Element {
  const { t } = useI18n();
  const controller = useTeammateManagementListController({ channels, providers, teammates, templates, t });
  const initialLoading = isLoading && controller.model.rows.length === 0;
  const emptyWorkspace = !isLoading && controller.model.rows.length === 0;
  const noResults = controller.model.rows.length > 0 && controller.visibleRows.length === 0;

  return (
    <section className="teammate-add-panel teammate-management-list-panel" aria-label={t("Workspace teammates")}>
      <div className="teammate-management-list-head">
        <span className="teammate-management-list-title">
          <Users aria-hidden="true" size={16} />
          <span>
            <h2>{t("Workspace teammates")}</h2>
            <small>{t("{count} configured", { count: controller.model.counts.active })}</small>
          </span>
        </span>
        <IconButton
          icon={RefreshCw}
          label={t("Refresh teammates")}
          loading={isLoading}
          loadingLabel={t("Loading AI teammates")}
          onClick={onRefresh}
        />
      </div>

      <div className="teammate-management-list-toolbar" role="toolbar" aria-label={t("Teammate list controls")}>
        <Input
          aria-label={t("Search teammates")}
          autoComplete="off"
          prefix={<Search aria-hidden="true" />}
          placeholder={t("Search teammates")}
          size="sm"
          value={controller.query}
          onChange={(event) => controller.setQuery(event.currentTarget.value)}
        />
        <Select
          aria-label={t("Filter teammates")}
          size="sm"
          value={controller.filter}
          onChange={(event) => controller.setFilter(event.currentTarget.value as typeof controller.filter)}
        >
          <option value="all">{t("All")}</option>
          <option value="ready">{t("Ready")}</option>
          <option value="needs-model">{t("Needs model")}</option>
          <option value="hidden">{t("Hidden")}</option>
        </Select>
      </div>

      {loadErrorMessage ? (
        <InlineFeedback className="teammate-management-list-feedback" tone="danger">
          {t("Teammates could not be refreshed. The last loaded list is still shown.")}
        </InlineFeedback>
      ) : null}

      {onOpenCouncils ? (
        <section className="teammate-council-inline-entry" aria-label={t("Council workspace entry")}>
          <span>
            <Users aria-hidden="true" size={15} />
            <small>{t("Teammates can join councils for shared management.")}</small>
          </span>
          <Button size="sm" variant="secondary" onClick={onOpenCouncils}>
            {t("Open Council Workspace")}
          </Button>
        </section>
      ) : null}

      {initialLoading ? (
        <TeammateListSkeleton />
      ) : emptyWorkspace ? (
        <EmptyState
          className="teammate-empty"
          compact
          icon={<Bot />}
          title={t("No workspace teammates")}
          action={(
            <Button leadingIcon={<UserPlus aria-hidden="true" />} size="sm" variant="primary" onClick={onCreate}>
              {t("New AI teammate")}
            </Button>
          )}
        />
      ) : noResults ? (
        <EmptyState
          className="teammate-management-no-results"
          compact
          icon={<Search />}
          title={t("No teammates match the current filters")}
          action={(
            <Button size="sm" variant="secondary" onClick={controller.clearFilters}>
              {t("Clear filters")}
            </Button>
          )}
        />
      ) : (
        <div className="teammate-draft-list" role="list" aria-label={t("Teammate list")}>
          {controller.visibleRows.map((row) => (
            <TeammateManagementRow
              key={row.draft.id}
              actionErrorMessage={actionErrorMessagesByTeammateId[row.draft.id]}
              cwd={cwd}
              row={row}
              settingsToolMode={settingsToolMode}
              onOpenProviders={onOpenProviders}
              onOpenTeammate={onOpenTeammate}
              onRemoveTeammate={onRemoveTeammate}
              onToggleTeammateHidden={onToggleTeammateHidden}
              onToggleTeammatePinned={onToggleTeammatePinned}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TeammateManagementRow({
  actionErrorMessage,
  cwd,
  onOpenProviders,
  onOpenTeammate,
  onRemoveTeammate,
  onToggleTeammateHidden,
  onToggleTeammatePinned,
  row,
  settingsToolMode,
}: {
  readonly actionErrorMessage?: string;
  readonly cwd: string;
  readonly onOpenProviders: () => void;
  readonly onOpenTeammate?: (teammateId: string) => void;
  readonly onRemoveTeammate: (teammateId: string) => void;
  readonly onToggleTeammateHidden: (teammateId: string) => void;
  readonly onToggleTeammatePinned: (teammateId: string) => void;
  readonly row: TeammateManagementRowViewModel;
  readonly settingsToolMode: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const roleSummary = row.roleLabelKey ? t(row.roleLabelKey) : roleLabel(row.roleKey, t);
  const modelLabel = row.modelLabelKey ? t(row.modelLabelKey) : row.modelLabel;
  const channelLabel = row.channelNames.length ? row.channelNames.join(", ") : t("No channel");
  const relativeTime = relativeDraftTime(row.draft.updatedAt);

  return (
    <DataRow
      className="teammate-draft-row teammate-management-row"
      data-hidden={row.draft.hidden || undefined}
      data-status={row.status.id}
      role="listitem"
      identity={(
        <span className="teammate-management-row-identity">
          <TeammateAvatarView teammate={row.draft} cwd={cwd} compact />
          <span className="teammate-draft-copy">
            <strong title={row.draft.displayName}>{row.draft.displayName}</strong>
            <small title={roleSummary}>{roleSummary}</small>
          </span>
        </span>
      )}
      summary={(
        <>
          <span className="teammate-management-row-summary">
            <span className="teammate-model-pill" title={modelLabel}>{modelLabel}</span>
            <span className="teammate-channel-pill" title={channelLabel}>{channelLabel}</span>
            <time className="teammate-updated-time" dateTime={row.draft.updatedAt}>
              {t(relativeTime.key, relativeTime.values)}
            </time>
          </span>
          {actionErrorMessage ? (
            <InlineFeedback data-teammate-action-error={row.draft.id} tone="danger">
              {actionErrorMessage}
            </InlineFeedback>
          ) : null}
        </>
      )}
      status={(
        <StatusIndicator
          className={`teammate-row-status ${row.status.className}`}
          label={t(row.status.labelKey)}
          tone={row.status.tone}
        />
      )}
      actions={(
        <span className="teammate-row-actions">
          {row.primaryAction === "open" && onOpenTeammate ? (
            <Button
              className="teammate-row-primary-action"
              aria-label={settingsToolMode ? t("Open chat in app") : undefined}
              size="sm"
              title={settingsToolMode ? t("Open chat in app") : undefined}
              variant="ghost"
              onClick={() => onOpenTeammate(row.draft.id)}
            >
              {t(settingsToolMode ? "Open teammate chat" : "Open")}
            </Button>
          ) : row.primaryAction === "configure-model" ? (
            <Button
              className="teammate-row-primary-action"
              leadingIcon={<PlugZap aria-hidden="true" />}
              size="sm"
              variant="ghost"
              onClick={onOpenProviders}
            >
              {t("Configure model")}
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                className="teammate-row-menu-trigger"
                icon={MoreHorizontal}
                label={t("Teammate actions")}
                tooltip=""
              />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => onToggleTeammatePinned(row.draft.id)}>
                <span className="ling-ui-menu-item-icon" aria-hidden="true">
                  {row.draft.pinned ? <PinOff /> : <Pin />}
                </span>
                <span>{t(row.draft.pinned ? "Unpin" : "Pin")}</span>
              </MenuItem>
              <MenuItem onSelect={() => onToggleTeammateHidden(row.draft.id)}>
                <span className="ling-ui-menu-item-icon" aria-hidden="true"><EyeOff /></span>
                <span>{t(row.draft.hidden ? "Show" : "Hide")}</span>
              </MenuItem>
              <MenuSeparator />
              <MenuItem tone="danger" onSelect={() => onRemoveTeammate(row.draft.id)}>
                <span className="ling-ui-menu-item-icon" aria-hidden="true"><Trash2 /></span>
                <span>{t("Delete")}</span>
              </MenuItem>
            </MenuContent>
          </Menu>
        </span>
      )}
    />
  );
}

function TeammateListSkeleton(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="teammate-draft-list teammate-management-list-skeleton" aria-label={t("Loading AI teammates")}>
      {Array.from({ length: 4 }, (_, index) => (
        <DataRow
          key={index}
          className="teammate-draft-row teammate-management-row"
          identity={<Skeleton width={`${72 - index * 6}%`} />}
          summary={<Skeleton width={`${82 - index * 5}%`} />}
          status={<Skeleton width={76} />}
          actions={<><Skeleton height={32} shape="block" width={86} /><Skeleton height={32} shape="block" width={32} /></>}
        />
      ))}
    </div>
  );
}
