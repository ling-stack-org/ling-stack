import { Plus, Search, X } from "lucide-react";
import { Button, Field, Input, Select } from "../../shared/ui/index.js";
import type { PluginManagerCopy } from "./plugin-manager-copy.js";
import type { PluginManagerController } from "./usePluginManagerController.js";
import type { Translate } from "../../i18n.js";
import { PluginManagerRefreshFeedback } from "./PluginManagerRefreshFeedback.js";

export function PluginManagerHeader({
  controller,
  copy,
  isLoading,
  busyCreating,
  onRefresh,
  t,
}: {
  readonly controller: PluginManagerController;
  readonly copy: PluginManagerCopy;
  readonly isLoading: boolean;
  readonly busyCreating: boolean;
  readonly onRefresh: () => void;
  readonly t: Translate;
}): React.JSX.Element {
  return (
    <>
      <header
        className="plugin-manager-header settings-plugin-manager-head"
        data-desktop-window-drag-region="true"
      >
        <h2 id="plugin-manager-title">{t("Plugin Manager")}</h2>
        <Button
          className="plugin-add-button"
          disabled={busyCreating}
          leadingIcon={<Plus aria-hidden="true" />}
          onClick={controller.openCreate}
          size="md"
          variant="primary"
        >
          {t("Add plugin")}
        </Button>
      </header>
      <div className="plugin-manager-toolbar" aria-label={t("Plugin Manager")}>
        <Field className="plugin-toolbar-field plugin-toolbar-search" label={copy.searchPlugins}>
          <Input
            aria-label={copy.searchPlugins}
            onChange={(event) => controller.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && controller.filters.query) controller.setQuery("");
            }}
            placeholder={copy.searchPlugins}
            prefix={<Search aria-hidden="true" />}
            size="sm"
            suffix={controller.filters.query ? (
              <button
                className="plugin-search-clear"
                type="button"
                aria-label={t("Clear search")}
                title={t("Clear search")}
                onClick={() => controller.setQuery("")}
              >
                <X aria-hidden="true" />
              </button>
            ) : undefined}
            value={controller.filters.query}
          />
        </Field>
        <Field className="plugin-toolbar-field plugin-toolbar-source" label={copy.sourceFilter}>
          <Select
            aria-label={copy.sourceFilter}
            onChange={(event) => controller.setSource(event.target.value as PluginManagerController["filters"]["source"])}
            size="sm"
            value={controller.filters.source}
          >
            <option value="all">{t("All")}</option>
            {controller.rows.some((row) => row.sourceKind === "built-in") ? <option value="built-in">{t("Built-in")}</option> : null}
            {controller.rows.some((row) => row.sourceKind === "bundled") ? <option value="bundled">{t("Bundled")}</option> : null}
            {controller.rows.some((row) => row.sourceKind === "trusted-local-preset") ? <option value="trusted-local-preset">{t("Trusted local")}</option> : null}
          </Select>
        </Field>
        <Field className="plugin-toolbar-field plugin-toolbar-status" label={copy.statusFilter}>
          <Select
            aria-label={copy.statusFilter}
            onChange={(event) => controller.setStatus(event.target.value as PluginManagerController["filters"]["status"])}
            size="sm"
            value={controller.filters.status}
          >
            <option value="all">{t("All")}</option>
            <option value="needs-action">{t("Needs attention")}</option>
            <option value="enabled">{t("Enabled status")}</option>
            <option value="disabled">{t("Disabled")}</option>
            <option value="unavailable">{t("Unavailable")}</option>
          </Select>
        </Field>
      </div>
      {controller.retainedRefreshError ? (
        <PluginManagerRefreshFeedback
          count={controller.rows.length}
          errorMessage={controller.loadError}
          loading={isLoading}
          onRetry={() => controller.runRefresh(onRefresh)}
          t={t}
        />
      ) : null}
    </>
  );
}
