import { Check, ChevronDown, Hand, Shield, ShieldCheck } from "lucide-react";
import { useState, type FocusEvent } from "react";
import { useI18n } from "../../i18n.js";
import type { ConversationAuthorizationMode } from "../../lib/conversation-authorization.js";

const authorizationOptions: readonly {
  readonly mode: ConversationAuthorizationMode;
  readonly icon: typeof Hand;
  readonly labelKey: string;
  readonly descriptionKey: string;
}[] = [
  {
    mode: "ask",
    icon: Hand,
    labelKey: "Ask first",
    descriptionKey: "Ask before workspace changes, commands, and external actions.",
  },
  {
    mode: "smart",
    icon: Shield,
    labelKey: "Smart authorization",
    descriptionKey: "Allow workspace edits; ask before commands, external actions, or policy risks.",
  },
  {
    mode: "always",
    icon: ShieldCheck,
    labelKey: "Always authorize",
    descriptionKey: "Use full access for this conversation after explicit confirmation.",
  },
];

export function ConversationAuthorizationMenu({
  mode,
  onModeChange,
}: {
  readonly mode: ConversationAuthorizationMode;
  readonly onModeChange: (mode: ConversationAuthorizationMode) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const activeOption = authorizationOptions.find((option) => option.mode === mode) ?? authorizationOptions[1];

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  }

  function selectMode(nextMode: ConversationAuthorizationMode): void {
    onModeChange(nextMode);
    setOpen(false);
  }

  return (
    <div
      className="conversation-authorization-menu"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={handleBlur}
    >
      <button
        className="conversation-tool-button conversation-authorization-trigger"
        type="button"
        aria-label={t("Selected authorization mode {label}", { label: t(activeOption.labelKey) })}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ShieldCheck size={15} />
        <span>{t(activeOption.labelKey)}</span>
        <ChevronDown className={open ? "expanded" : ""} size={13} />
      </button>
      {open ? (
        <div className="conversation-authorization-popover" role="menu" aria-label={t("Authorization mode")}>
          {authorizationOptions.map((option) => {
            const selected = option.mode === mode;
            const Icon = option.icon;
            return (
              <button
                key={option.mode}
                className={selected ? "conversation-authorization-option selected" : "conversation-authorization-option"}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={t(option.descriptionKey)}
                onClick={() => selectMode(option.mode)}
              >
                <Icon size={14} />
                <span>{t(option.labelKey)}</span>
                {selected ? <Check size={14} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
