import { Fragment, useState, type CSSProperties } from "react";
import { CheckCircle2, CircleAlert, Loader2, MoreHorizontal, Pencil, Play, PlugZap, Search, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  providerCheckDisplayGuidance,
  providerCheckDisplayMessage,
  providerCheckStatusLabel,
} from "../../lib/providers.js";
import { ActionMenuItem, OperationEmptyState } from "../../shared/components/index.js";
import type { ProviderCheckResult, ProviderPreset } from "../../types.js";
import type { ProviderCheckScope } from "./types.js";
import { readProviderRouteRowView } from "./provider-workbench-view-models.js";
import type { ProviderSetupIntent } from "./provider-workbench-view-models.js";

type ProviderMenuAnchor = { readonly id: string; readonly top: number; readonly right: number };

const providerRowMenuEstimatedHeight = 132;

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
  readonly onAddModel: (intent?: ProviderSetupIntent | "") => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onDelete: (providerId: string) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onUse: (provider: ProviderPreset) => void;
  readonly onStopUse: (provider: ProviderPreset) => void;
  readonly onToggleEnabled: (provider: ProviderPreset, enabled: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [openProviderMenu, setOpenProviderMenu] = useState<ProviderMenuAnchor>({ id: "", top: 0, right: 0 });
  const openProviderMenuId = openProviderMenu.id;

  function openProviderRowMenu(providerId: string, element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    const viewportPadding = 8;
    const shouldOpenUp = rect.bottom + providerRowMenuEstimatedHeight > window.innerHeight - viewportPadding;
    setOpenProviderMenu({
      id: providerId,
      top: shouldOpenUp
        ? Math.max(viewportPadding, rect.top - providerRowMenuEstimatedHeight)
        : rect.bottom,
      right: Math.max(viewportPadding, window.innerWidth - rect.right),
    });
  }

  function closeProviderRowMenu(): void {
    setOpenProviderMenu({ id: "", top: 0, right: 0 });
  }

  return (
    <div className="provider-table-shell">
      {providers.length === 0 ? (
        <OperationEmptyState
          compact
          icon={isLoading ? <Loader2 className="spin" /> : <PlugZap />}
          title={isLoading ? t("Loading providers...") : t("Add a model route to start using Ling.")}
          action={!isLoading ? (
            <span className="provider-empty-actions">
              <button className="primary-button compact-button" type="button" onClick={() => onAddModel("chat")}>
                {t("Add chat model")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => onAddModel("generation")}>
                {t("Add image generation model")}
              </button>
            </span>
          ) : undefined}
        />
      ) : filteredProviders.length === 0 ? (
        <OperationEmptyState compact icon={<Search />} title={t("No model presets match the current filters")} />
      ) : (
        <table className="provider-table">
          <thead>
            <tr>
              <th>{t("Model")}</th>
              <th>{t("Usage")}</th>
              <th>{t("Status")}</th>
              <th className="provider-table-action-head">{t("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {filteredProviders.map((provider) => {
              const providerIsChecking = checkingProviderIds.includes(provider.id);
              const rowCheckResult = checkScope === "row" && checkedProviderId === provider.id ? checkResult : undefined;
              const rowCheckMessage = rowCheckResult ? providerCheckDisplayMessage(rowCheckResult, provider, t) : "";
              const rowCheckGuidance = rowCheckResult ? providerCheckDisplayGuidance(rowCheckResult, provider, t) : "";
              const row = readProviderRouteRowView({
                provider,
                selectedProviderId,
                rowCheckGuidance,
                t,
              });
              const primaryAction = row.primaryAction === "add_api_key" ? (
                <button className="secondary-button compact-button provider-main-action" type="button" onClick={() => onEdit(provider)}>
                  <Pencil size={14} />
                  {t("Add API key")}
                </button>
              ) : row.primaryAction === "check" ? (
                <button className="secondary-button compact-button provider-main-action" type="button" disabled={isCheckingProviders} onClick={() => onCheck(provider.id)}>
                  {providerIsChecking && checkScope === "row" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                  {t("Check")}
                </button>
              ) : row.primaryAction === "set_default" ? (
                <button className="secondary-button compact-button provider-main-action" type="button" onClick={() => onUse(provider)}>
                  <Play size={14} />
                  {t("Set default")}
                </button>
              ) : row.primaryAction === "enable" ? (
                <button className="secondary-button compact-button provider-main-action" type="button" disabled={isCheckingProviders} onClick={() => onToggleEnabled(provider, true)}>
                  <CheckCircle2 size={14} />
                  {t("Enable")}
                </button>
              ) : null;

              return (
                <Fragment key={provider.id}>
                  <tr className={row.selectedForRun ? "provider-row selected" : "provider-row"}>
                    <td className="provider-name-cell">
                      <span className="provider-name-main">
                        <span
                          className="provider-avatar"
                          role="img"
                          aria-label={row.sourceLabel}
                          title={row.sourceLabel}
                          data-tooltip={row.sourceLabel}
                        >
                          {row.sourceInitial}
                        </span>
                        <span className="provider-name-copy">
                          <strong>{row.modelLabel}</strong>
                          {row.secondaryLabel ? <small>{row.secondaryLabel}</small> : null}
                        </span>
                      </span>
                    </td>
                    <td className="provider-usage-cell">
                      <span className="provider-usage-labels">
                        {(row.usageLabels.length > 0 ? row.usageLabels : [t("General")]).map((label) => (
                          <span className="provider-usage-label" key={label}>{label}</span>
                        ))}
                      </span>
                    </td>
                    <td className="provider-status-cell">
                      <span className="provider-status-stack">
                        <span className={row.primaryStatusClass}>{row.primaryStatusLabel}</span>
                        {row.statusHint ? (
                          <span
                            className="provider-status-hint"
                            data-tooltip={row.statusHint}
                            title={row.statusHint}
                            aria-label={row.statusHint}
                            tabIndex={0}
                          >
                            <CircleAlert size={12} />
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <div className="provider-actions">
                        {primaryAction}
                        {row.showInlineCheck ? (
                          <button
                            className="provider-row-icon-action"
                            type="button"
                            aria-label={t("Check")}
                            title={t("Check")}
                            data-tooltip={t("Check")}
                            disabled={isCheckingProviders}
                            onClick={() => onCheck(provider.id)}
                          >
                            {providerIsChecking && checkScope === "row"
                              ? <Loader2 className="spin" size={15} />
                              : <CheckCircle2 size={15} />}
                          </button>
                        ) : null}
                        {row.showInlineEdit ? (
                          <button
                            className="provider-row-icon-action"
                            type="button"
                            aria-label={t("Edit")}
                            title={t("Edit")}
                            data-tooltip={t("Edit")}
                            onClick={() => onEdit(provider)}
                          >
                            <Pencil size={15} />
                          </button>
                        ) : null}
                        <span
                          className={openProviderMenuId === provider.id ? "provider-row-menu hover-action-menu open" : "provider-row-menu hover-action-menu"}
                          onMouseEnter={(event) => openProviderRowMenu(provider.id, event.currentTarget)}
                          onMouseLeave={closeProviderRowMenu}
                          onFocus={(event) => openProviderRowMenu(provider.id, event.currentTarget)}
                          onBlur={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                              closeProviderRowMenu();
                            }
                          }}
                        >
                          <button
                            className="provider-row-menu-trigger hover-action-menu-trigger"
                            type="button"
                            aria-label={t("More")}
                            title={t("More")}
                            aria-haspopup="menu"
                            onMouseDown={(event) => event.preventDefault()}
                          >
                            <MoreHorizontal size={15} />
                          </button>
                          <span
                            className="provider-row-menu-popover hover-action-menu-popover"
                            role="menu"
                            hidden={openProviderMenuId !== provider.id}
                            style={{
                              "--provider-row-menu-top": `${openProviderMenu.top}px`,
                              "--provider-row-menu-right": `${openProviderMenu.right}px`,
                            } as CSSProperties}
                          >
                            {row.selectedForRun ? (
                              <ActionMenuItem
                                icon={<X size={14} />}
                                label={t("Clear default")}
                                onSelect={() => {
                                  closeProviderRowMenu();
                                  onStopUse(provider);
                                }}
                              />
                            ) : null}
                            {row.showDisableMenuAction ? (
                              <ActionMenuItem
                                icon={<X size={14} />}
                                label={t("Disable")}
                                disabled={isCheckingProviders}
                                onSelect={() => {
                                  closeProviderRowMenu();
                                  onToggleEnabled(provider, false);
                                }}
                              />
                            ) : null}
                            <ActionMenuItem
                              icon={<Trash2 size={14} />}
                              label={t("Delete")}
                              danger
                              onSelect={() => {
                                closeProviderRowMenu();
                                onDelete(provider.id);
                              }}
                            />
                          </span>
                        </span>
                      </div>
                    </td>
                  </tr>
                  {rowCheckResult ? (
                    <tr className={rowCheckResult.ok ? "provider-check-feedback-row ok" : "provider-check-feedback-row bad"}>
                      <td colSpan={4}>
                        <div className="provider-check-feedback">
                          {rowCheckResult.ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
                          <div className="provider-check-feedback-copy">
                            <strong>{t(rowCheckResult.ok ? "Check passed" : "Check failed")}</strong>
                            <p>{rowCheckMessage}</p>
                            {rowCheckGuidance ? <small>{rowCheckGuidance}</small> : null}
                            {rowCheckResult.message ? (
                              <details className="provider-check-raw-details">
                                <summary>{t("Check details")}</summary>
                                <small>{providerCheckStatusLabel(rowCheckResult, t)}: {t(rowCheckResult.message)}</small>
                              </details>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
