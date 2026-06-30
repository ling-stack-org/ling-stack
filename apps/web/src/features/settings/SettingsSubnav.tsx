import { useI18n } from "../../i18n.js";

export interface SettingsSubnavOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
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
    <div className="settings-subnav-shell">
      <div className="settings-subnav" role="tablist" aria-label={t(label)}>
        {options.map((option) => (
          <button
            key={option.id}
            className={option.id === activeId ? "settings-subnav-item active" : "settings-subnav-item"}
            type="button"
            role="tab"
            aria-selected={option.id === activeId}
            onClick={() => onChange(option.id)}
          >
            <span>{t(option.label)}</span>
            {option.badge ? <small>{t(option.badge)}</small> : null}
          </button>
        ))}
      </div>
      {activeOption?.description ? <p className="settings-subnav-description">{t(activeOption.description)}</p> : null}
    </div>
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
