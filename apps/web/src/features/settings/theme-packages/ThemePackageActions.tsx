import { Eye, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { useRef } from "react";
import type { RegisteredTheme } from "../../../shared/ui/index.js";
import {
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";

export function ThemePackageActions({
  busy,
  theme,
  onDelete,
  onPreview,
  onReimport,
}: {
  readonly busy: boolean;
  readonly theme: RegisteredTheme;
  readonly onDelete: (theme: RegisteredTheme, trigger: HTMLButtonElement | null) => void;
  readonly onPreview: (theme: RegisteredTheme, trigger: HTMLButtonElement | null) => void;
  readonly onReimport: (theme: RegisteredTheme, trigger: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          ref={triggerRef}
          disabled={busy}
          icon={MoreHorizontal}
          label={t("Theme actions for {name}", { name: theme.manifest.name })}
          size="sm"
          tooltip=""
        />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => onPreview(theme, triggerRef.current)}>
          <Eye aria-hidden="true" />
          {t("Preview")}
        </MenuItem>
        {theme.source !== "built-in" ? (
          <>
            <MenuItem onSelect={() => onReimport(theme, triggerRef.current)}>
              <RefreshCw aria-hidden="true" />
              {t("Reimport")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem tone="danger" onSelect={() => onDelete(theme, triggerRef.current)}>
              <Trash2 aria-hidden="true" />
              {t("Delete")}
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
