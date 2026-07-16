import { Command, HeartPulse, SlidersHorizontal, Users, UsersRound } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n.js";

export type ChannelSettingsSection = "general" | "workspace" | "members" | "councils" | "health";

const channelSettingsSections: readonly {
  readonly id: ChannelSettingsSection;
  readonly label: string;
  readonly icon: typeof SlidersHorizontal;
}[] = [
  { id: "general", label: "Channel general", icon: SlidersHorizontal },
  { id: "workspace", label: "Workspace", icon: Command },
  { id: "members", label: "Members", icon: Users },
  { id: "councils", label: "Channel councils", icon: UsersRound },
  { id: "health", label: "Channel health", icon: HeartPulse },
];

export function ChannelSettingsNavigation({
  activeSection,
  onChange,
}: {
  readonly activeSection: ChannelSettingsSection;
  readonly onChange: (section: ChannelSettingsSection) => void;
}): JSX.Element {
  const { t } = useI18n();
  const buttonRefs = useRef(new Map<ChannelSettingsSection, HTMLButtonElement>());

  function focusSection(section: ChannelSettingsSection): void {
    onChange(section);
    requestAnimationFrame(() => buttonRefs.current.get(section)?.focus());
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void {
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % channelSettingsSections.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + channelSettingsSections.length) % channelSettingsSections.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = channelSettingsSections.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextSection = channelSettingsSections[nextIndex]?.id;
    if (nextSection) {
      focusSection(nextSection);
    }
  }

  return (
    <div className="channel-settings-tabs-scroll">
      <div className="channel-settings-tabs" role="tablist" aria-label={t("Channel settings navigation")}>
        {channelSettingsSections.map((section, index) => {
          const Icon = section.icon;
          const active = section.id === activeSection;
          return (
            <button
              key={section.id}
              ref={(element) => {
                if (element) {
                  buttonRefs.current.set(section.id, element);
                } else {
                  buttonRefs.current.delete(section.id);
                }
              }}
              id={`channel-settings-tab-${section.id}`}
              className={active ? "channel-settings-tab active" : "channel-settings-tab"}
              type="button"
              role="tab"
              aria-controls={`channel-settings-panel-${section.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(section.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{t(section.label)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
