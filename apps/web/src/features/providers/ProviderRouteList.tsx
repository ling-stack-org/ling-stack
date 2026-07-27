import { Fragment } from "react";
import { CircleAlert, PlugZap, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  InlineFeedback,
  InspectorSection,
  Skeleton,
  StatusIndicator,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tooltip,
} from "../../shared/ui/index.js";
import {
  providerCheckDisplayGuidance,
  providerCheckDisplayMessage,
  providerCheckStatusLabel,
} from "../../lib/providers.js";
import type { ProviderCheckResult, ProviderPreset } from "../../types.js";
import { ProviderRouteActions } from "./ProviderRouteActions.js";
import type { ProviderCheckScope } from "./types.js";
import { readProviderRouteRowView, type ProviderSetupIntent } from "./provider-workbench-view-models.js";

export function ProviderRouteList({
  providers,
  filteredProviders,
  selectedProviderId,
  isLoading,
  isCheckingProviders,
  checkingProviderIds,
  checkedProviderId,
  checkResult,
  checkScope,
  hasActiveFilters,
  onClearFilters,
  onAddModel,
  onEdit,
  onDelete,
  onCheck,
  onUse,
  onStopUse,
  onToggleEnabled,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly filteredProviders: readonly ProviderPreset[];
  readonly selectedProviderId: string;
  readonly isLoading: boolean;
  readonly isCheckingProviders: boolean;
  readonly checkingProviderIds: readonly string[];
  readonly checkedProviderId: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly checkScope: ProviderCheckScope | undefined;
  readonly hasActiveFilters: boolean;
  readonly onClearFilters: () => void;
  readonly onAddModel: (intent?: ProviderSetupIntent | "") => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onDelete: (provider: ProviderPreset) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onUse: (provider: ProviderPreset) => void;
  readonly onStopUse: (provider: ProviderPreset) => void;
  readonly onToggleEnabled: (provider: ProviderPreset, enabled: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (isLoading && providers.length === 0) return <ProviderTableSkeleton />;

  if (providers.length === 0) {
    return (
      <div className="provider-table-shell">
        <EmptyState
          compact
          icon={<PlugZap />}
          title={t("Add a model route to start using Ling.")}
          action={(
            <span className="provider-empty-actions">
              <Button size="sm" variant="primary" onClick={() => onAddModel("chat")}>{t("Add chat model")}</Button>
              <Button size="sm" onClick={() => onAddModel("generation")}>{t("Add image generation model")}</Button>
            </span>
          )}
        />
      </div>
    );
  }

  if (filteredProviders.length === 0) {
    return (
      <div className="provider-table-shell">
        <EmptyState
          compact
          icon={<Search />}
          title={t("No model presets match the current filters")}
          action={hasActiveFilters ? <Button size="sm" onClick={onClearFilters}>{t("Clear filters")}</Button> : undefined}
        />
      </div>
    );
  }

  return (
    <TableContainer className="provider-table-shell">
      <Table className="provider-table">
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t("Model")}</TableHeaderCell>
            <TableHeaderCell>{t("Usage")}</TableHeaderCell>
            <TableHeaderCell>{t("Status")}</TableHeaderCell>
            <TableHeaderCell className="provider-table-action-head">{t("Actions")}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {filteredProviders.map((provider) => {
            const providerIsChecking = checkingProviderIds.includes(provider.id);
            const rowCheckResult = checkScope === "row" && checkedProviderId === provider.id ? checkResult : undefined;
            const rowCheckGuidance = rowCheckResult ? providerCheckDisplayGuidance(rowCheckResult, provider, t) : "";
            const row = readProviderRouteRowView({ provider, selectedProviderId, rowCheckGuidance, t });
            const tone = row.primaryStatusTone === "attention" ? "warning" : row.primaryStatusTone;
            return (
              <Fragment key={provider.id}>
                <TableRow className={row.selectedForRun ? "provider-row selected" : "provider-row"}>
                  <TableCell className="provider-name-cell">
                    <span className="provider-name-main">
                      <Tooltip content={row.sourceLabel}>
                        <span className="provider-avatar" role="img" aria-label={row.sourceLabel} title={row.sourceLabel}>{row.sourceInitial}</span>
                      </Tooltip>
                      <span className="provider-name-copy">
                        <strong title={row.modelLabel}>{row.modelLabel}</strong>
                        {row.secondaryLabel ? <small title={row.secondaryLabel}>{row.secondaryLabel}</small> : null}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="provider-usage-cell">
                    <span className="provider-usage-labels">
                      {(row.usageLabels.length ? row.usageLabels : [t("General")]).map((label) => (
                        <Badge className="provider-usage-label" key={label} tone="neutral">{label}</Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="provider-status-cell">
                    <span className="provider-status-stack">
                      <StatusIndicator
                        className={`${row.primaryStatusClass} provider-primary-status`}
                        label={row.primaryStatusLabel}
                        tone={tone}
                      />
                      {row.statusHint ? (
                        <IconButton
                          className="provider-status-hint"
                          icon={CircleAlert}
                          label={t("Status")}
                          tooltip={row.statusHint}
                        />
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ProviderRouteActions
                      provider={provider}
                      row={row}
                      checking={providerIsChecking}
                      checkingAny={isCheckingProviders}
                      checkScope={checkScope}
                      onCheck={onCheck}
                      onDelete={onDelete}
                      onEdit={onEdit}
                      onStopUse={onStopUse}
                      onToggleEnabled={onToggleEnabled}
                      onUse={onUse}
                    />
                  </TableCell>
                </TableRow>
                {rowCheckResult ? (
                  <TableRow className={rowCheckResult.ok ? "provider-check-feedback-row ok" : "provider-check-feedback-row bad"}>
                    <TableCell colSpan={4}>
                      <InlineFeedback
                        className="provider-check-feedback"
                        tone={rowCheckResult.ok ? "success" : "danger"}
                        title={t(rowCheckResult.ok ? "Check passed" : "Check failed")}
                      >
                        <p>{providerCheckDisplayMessage(rowCheckResult, provider, t)}</p>
                        {rowCheckGuidance ? <small>{rowCheckGuidance}</small> : null}
                        {rowCheckResult.message ? (
                          <InspectorSection className="provider-check-raw-details" title={t("Check details")}>
                            <small>{providerCheckStatusLabel(rowCheckResult, t)}: {t(rowCheckResult.message)}</small>
                          </InspectorSection>
                        ) : null}
                      </InlineFeedback>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ProviderTableSkeleton(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="provider-table-shell provider-table-skeleton" aria-label={t("Loading providers...")} aria-busy="true">
      <span className="provider-loading-label">{t("Loading providers...")}</span>
      {[0, 1, 2, 3].map((row) => (
        <div className="provider-table-skeleton-row" key={row}>
          <Skeleton shape="text" />
          <Skeleton shape="text" />
          <Skeleton shape="text" />
          <Skeleton shape="text" />
        </div>
      ))}
    </div>
  );
}
