import { CheckCircle2, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/ui/index.js";
import type { ProviderPreset } from "../../types.js";
import type { ProviderCheckScope } from "./types.js";
import type { ProviderRouteRowView } from "./provider-workbench-view-models.js";

export function ProviderRouteActions({
  provider,
  row,
  checkScope,
  checking,
  checkingAny,
  onCheck,
  onDelete,
  onEdit,
  onToggleEnabled,
}: {
  readonly provider: ProviderPreset;
  readonly row: ProviderRouteRowView;
  readonly checkScope: ProviderCheckScope | undefined;
  readonly checking: boolean;
  readonly checkingAny: boolean;
  readonly onCheck: (providerId: string) => void;
  readonly onDelete: (provider: ProviderPreset) => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onToggleEnabled: (provider: ProviderPreset, enabled: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const primary = row.primaryAction === "add_api_key" ? (
    <Button className="provider-main-action" size="sm" leadingIcon={<Pencil />} onClick={() => onEdit(provider)}>
      {t("Add API key")}
    </Button>
  ) : row.primaryAction === "check" ? (
    <Button
      className="provider-main-action"
      size="sm"
      leadingIcon={<CheckCircle2 />}
      loading={checking && checkScope === "row"}
      loadingLabel={t("Checking")}
      disabled={checkingAny && !checking}
      onClick={() => onCheck(provider.id)}
    >
      {t("Check")}
    </Button>
  ) : row.primaryAction === "enable" ? (
    <Button className="provider-main-action" size="sm" leadingIcon={<CheckCircle2 />} disabled={checkingAny} onClick={() => onToggleEnabled(provider, true)}>
      {t("Enable")}
    </Button>
  ) : null;

  return (
    <div className="provider-actions">
      {primary}
      {row.showInlineCheck ? (
        <IconButton
          className="provider-row-icon-action"
          icon={CheckCircle2}
          label={t("Check")}
          loading={checking && checkScope === "row"}
          disabled={checkingAny && !checking}
          onClick={() => onCheck(provider.id)}
        />
      ) : null}
      {row.showInlineEdit ? (
        <IconButton className="provider-row-icon-action" icon={Pencil} label={t("Edit")} onClick={() => onEdit(provider)} />
      ) : null}
      <Menu>
        <MenuTrigger asChild>
          <IconButton className="provider-row-menu-trigger" icon={MoreHorizontal} label={t("More")} tooltip="" />
        </MenuTrigger>
        <MenuContent className="provider-row-menu-popover" align="end">
          {row.showDisableMenuAction ? (
            <MenuItem disabled={checkingAny} onSelect={() => onToggleEnabled(provider, false)}>
              <X aria-hidden="true" />
              {t("Disable")}
            </MenuItem>
          ) : null}
          {row.showDisableMenuAction ? <MenuSeparator /> : null}
          <MenuItem tone="danger" onSelect={() => onDelete(provider)}>
            <Trash2 aria-hidden="true" />
            {t("Delete")}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
