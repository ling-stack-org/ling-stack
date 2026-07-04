import { Fragment, useState, type CSSProperties } from "react";
import { CheckCircle2, CircleAlert, Loader2, MoreHorizontal, Pencil, Play, PlugZap, Search, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  canUseProviderForRun,
  providerCheckDisplayGuidance,
  providerCheckDisplayMessage,
  providerCheckStatusLabel,
  providerLastCheckClass,
  providerLastCheckLabel,
  providerLastCheckTitle,
  providerModelRouteLabel,
  providerSecretStatusClass,
  providerSecretStatusLabel,
} from "../../lib/providers.js";
import { ActionMenuItem, OperationEmptyState } from "../../shared/components/index.js";
import type { ProviderCheckResult, ProviderPreset, ProviderTemplate } from "../../types.js";
import type { ProviderCheckScope } from "./types.js";
import { providerInitial, readProviderRouteRowView } from "./provider-workbench-view-models.js";

type ProviderMenuAnchor = { readonly id: string; readonly top: number; readonly right: number };

const providerRowMenuEstimatedHeight = 132;

export function ProviderRouteList({
  providers,
  filteredProviders,
  templates,
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
  readonly templates: readonly ProviderTemplate[];
  readonly selectedProviderId: string;
  readonly isLoading: boolean;
  readonly isCheckingProviders: boolean;
  readonly checkingProviderIds: readonly string[];
  readonly checkedProviderId: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly checkScope: ProviderCheckScope | undefined;
  readonly onAddModel: () => void;
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
          title={isLoading ? t("Loading providers...") : t("Configure a supplier endpoint, fetch its exposed models, and save selected presets.")}
          action={!isLoading ? (
            <button className="primary-button compact-button" type="button" onClick={onAddModel}>
              {t("Add model")}
            </button>
          ) : undefined}
        />
      ) : filteredProviders.length === 0 ? (
        <OperationEmptyState compact icon={<Search />} title={t("No model presets match the current filters")} />
      ) : (
        <table className="provider-table">
          <thead>
            <tr>
              <th>{t("Supplier")}</th>
              <th>{t("Model")}</th>
              <th>{t("Base URL")}</th>
              <th>{t("API key status")}</th>
              <th>{t("Check status")}</th>
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
                templates,
                selectedProviderId,
                rowCheckGuidance,
                t,
              });

              return (
                <Fragment key={provider.id}>
                  <tr className={row.selectedForRun ? "provider-row selected" : "provider-row"}>
                    <td className="provider-name-cell">
                      <span className="provider-name-main">
                        <span className="provider-avatar" aria-hidden="true">{providerInitial(provider.displayName)}</span>
                        <span className="provider-name-copy">
                          <strong>{provider.displayName}</strong>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="provider-model-name">{providerModelRouteLabel(provider, templates)}</span>
                      <div className="provider-meta-line provider-table-compat-line">
                        <span>{t("Capabilities")}: {row.capabilitySummary}</span>
                        <span>{row.lastCheckSummary}</span>
                      </div>
                      {row.generationRuntimeSummary ? (
                        <div className="provider-meta-line provider-generation-status-line">
                          <span>{row.generationRuntimeSummary}</span>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div className="provider-meta-line mono provider-endpoint-cell">
                        <span><span className="provider-endpoint-label">{t("Base URL")}: </span>{row.effectiveBaseUrl}</span>
                      </div>
                    </td>
                    <td>
                      <span className="provider-key-status-stack">
                        <span className={providerSecretStatusClass(provider)}>{providerSecretStatusLabel(provider, t)}</span>
                        {row.secretHeaderSummary ? <small>{row.secretHeaderSummary}</small> : null}
                      </span>
                    </td>
                    <td>
                      <span className={providerLastCheckClass(provider)} title={providerLastCheckTitle(provider, t)}>
                        {providerLastCheckLabel(provider, t)}
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
                        {row.missingApiKey ? (
                          <button className="secondary-button compact-button provider-main-action" type="button" onClick={() => onEdit(provider)}>
                            <Pencil size={14} />
                            {t("Fix config")}
                          </button>
                        ) : !row.ready && canUseProviderForRun(provider) ? (
                          <button className="secondary-button compact-button provider-main-action" type="button" disabled={isCheckingProviders} onClick={() => onCheck(provider.id)}>
                            {providerIsChecking && checkScope === "row" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                            {t("Check")}
                          </button>
                        ) : row.chatCapable ? (
                          <button
                            className="secondary-button compact-button provider-main-action"
                            type="button"
                            disabled={!row.selectedForRun && !row.canBeDefault}
                            onClick={() => {
                              if (row.selectedForRun) {
                                onStopUse(provider);
                                return;
                              }
                              onUse(provider);
                            }}
                          >
                            {row.selectedForRun ? <X size={14} /> : <Play size={14} />}
                            {row.selectedForRun ? t("Clear default") : t("Set default")}
                          </button>
                        ) : (
                          <span className={row.generationCapable ? "provider-action-note" : "provider-action-note muted"}>
                            {row.generationCapable ? t("Generation model") : t("Not for chat")}
                          </span>
                        )}
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
                            <ActionMenuItem
                              icon={<Pencil size={14} />}
                              label={t("Edit")}
                              onSelect={() => {
                                closeProviderRowMenu();
                                onEdit(provider);
                              }}
                            />
                            <ActionMenuItem
                              icon={provider.enabled ? <X size={14} /> : <CheckCircle2 size={14} />}
                              label={provider.enabled ? t("Disable") : t("Enable")}
                              disabled={isCheckingProviders}
                              onSelect={() => {
                                closeProviderRowMenu();
                                onToggleEnabled(provider, !provider.enabled);
                              }}
                            />
                            {!row.mainActionIsCheck ? (
                              <ActionMenuItem
                                icon={providerIsChecking && checkScope === "row" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                                label={t("Check")}
                                disabled={isCheckingProviders || row.missingApiKey}
                                onSelect={() => {
                                  closeProviderRowMenu();
                                  onCheck(provider.id);
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
                      <td colSpan={7}>
                        <div className="provider-check-feedback">
                          {rowCheckResult.ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
                          <div className="provider-check-feedback-copy">
                            <span>
                              <strong>{t(rowCheckResult.ok ? "Check passed" : "Check failed")}</strong>
                              <em>{providerCheckStatusLabel(rowCheckResult, t)}</em>
                            </span>
                            <p>{rowCheckMessage}</p>
                            {rowCheckGuidance ? <small>{rowCheckGuidance}</small> : null}
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
