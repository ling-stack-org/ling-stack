import { RefreshCw, Trash2 } from "lucide-react";
import { useRef } from "react";
import type { ThemePackageRepairItem } from "../../../shared/ui/theme/theme-package-runtime.js";
import { Button, InlineFeedback } from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";

export function ThemePackageRepairList({
  items,
  onDelete,
  onReimport,
}: {
  readonly items: readonly ThemePackageRepairItem[];
  readonly onDelete: (item: ThemePackageRepairItem, trigger: HTMLButtonElement | null) => void;
  readonly onReimport: (item: ThemePackageRepairItem, trigger: HTMLButtonElement | null) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <InlineFeedback
      className="settings-theme-repair-list"
      data-ui2-theme-package-repairs=""
      title={t("Theme package needs attention")}
      tone="warning"
    >
      {items.map((item) => (
        <ThemePackageRepairRow
          item={item}
          key={`${item.kind}:${item.themeId}`}
          onDelete={onDelete}
          onReimport={onReimport}
        />
      ))}
    </InlineFeedback>
  );
}

function ThemePackageRepairRow({
  item,
  onDelete,
  onReimport,
}: {
  readonly item: ThemePackageRepairItem;
  readonly onDelete: (item: ThemePackageRepairItem, trigger: HTMLButtonElement | null) => void;
  readonly onReimport: (item: ThemePackageRepairItem, trigger: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const reimportRef = useRef<HTMLButtonElement | null>(null);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  const detail = item.kind === "legacy-browser-only"
    ? t("This theme only exists in older browser storage. Reimport its original file to use it in Desktop.")
    : t("This theme package is unavailable. Reimport it to repair the installation or delete it.");
  return (
    <div className="settings-theme-repair-row" data-theme-repair-kind={item.kind}>
      <span>
        <strong>{item.displayName}</strong>
        <small>{detail}</small>
      </span>
      <span className="settings-theme-repair-actions">
        <Button
          ref={reimportRef}
          leadingIcon={<RefreshCw aria-hidden="true" />}
          size="sm"
          variant="secondary"
          onClick={() => onReimport(item, reimportRef.current)}
        >
          {t("Reimport")}
        </Button>
        <Button
          ref={deleteRef}
          aria-label={t("Delete theme {name}?", { name: item.displayName })}
          leadingIcon={<Trash2 aria-hidden="true" />}
          size="sm"
          variant="ghost"
          onClick={() => onDelete(item, deleteRef.current)}
        >
          {t("Delete")}
        </Button>
      </span>
    </div>
  );
}
