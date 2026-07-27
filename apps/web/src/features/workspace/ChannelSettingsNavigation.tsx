import { Command, HeartPulse, SlidersHorizontal, Users, UsersRound } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { TabsList, TabsTrigger } from "../../shared/ui/index.js";

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

export function ChannelSettingsNavigation(): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="channel-settings-tabs-scroll">
      <TabsList
        className="channel-settings-tabs"
        aria-label={t("Channel settings navigation")}
        appearance="line"
        size="sm"
      >
        {channelSettingsSections.map((section) => {
          const Icon = section.icon;
          return (
            <TabsTrigger
              key={section.id}
              id={`channel-settings-tab-${section.id}`}
              className="channel-settings-tab"
              aria-controls={`channel-settings-panel-${section.id}`}
              value={section.id}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{t(section.label)}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </div>
  );
}
