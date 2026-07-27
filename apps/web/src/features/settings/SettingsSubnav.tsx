import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";

export interface SettingsSubnavOption {
  readonly id: string;
  readonly label: string;
  readonly badge?: string;
}

export function SettingsSubnav({
  label,
  options,
  activeId,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly SettingsSubnavOption[];
  readonly activeId: string;
  readonly onChange: (id: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const activeOption = options.find((option) => option.id === activeId) ?? options[0];

  return (
    <Tabs className="settings-subnav-shell" value={activeOption?.id ?? activeId} onValueChange={onChange}>
      <TabsList className="settings-subnav" appearance="contained" size="sm" aria-label={t(label)}>
        {options.map((option) => (
          <TabsTrigger
            key={option.id}
            className={option.id === activeId ? "settings-subnav-item active" : "settings-subnav-item"}
            value={option.id}
          >
            <span>{t(option.label)}</span>
            {option.badge ? <small className="ling-ui-tabs-trigger-badge">{t(option.badge)}</small> : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function SettingsMetaLine({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly { readonly label: string; readonly value: string | number }[];
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="settings-meta-line" aria-label={label}>
      {items.map((item) => (
        <span key={item.label}>
          <small>{t(item.label)}</small>
          <strong>{item.value}</strong>
        </span>
      ))}
    </div>
  );
}
