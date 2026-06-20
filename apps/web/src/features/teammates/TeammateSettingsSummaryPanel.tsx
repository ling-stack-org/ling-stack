import { Upload, UserCircle } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { MetaRow } from "../../shared/components/index.js";
import type { AiTeammate, ProviderPreset } from "../../types.js";
import { approvalProfileText } from "./helpers.js";

export function TeammateSettingsSummaryPanel({
  teammate,
  settingsProvider,
  channelCount,
  executableSkillCount,
  memoryReady,
  mcpBindingCount,
}: {
  readonly teammate: AiTeammate;
  readonly settingsProvider: ProviderPreset | undefined;
  readonly channelCount: number;
  readonly executableSkillCount: number;
  readonly memoryReady: boolean;
  readonly mcpBindingCount: number;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <aside className="teammate-settings-summary-panel" aria-label={t("Configuration summary")}>
      <section>
        <div className="panel-title split">
          <span>
            <UserCircle size={15} />
            <h3>{t("Configuration summary")}</h3>
          </span>
        </div>
        <div className="teammate-summary-list">
          <MetaRow label={t("Provider")} value={settingsProvider ? settingsProvider.displayName : t("None")} compact />
          <MetaRow label={t("Model")} value={settingsProvider?.model ?? "-"} compact />
          <MetaRow label={t("Approval")} value={approvalProfileText(teammate.approvalProfile, t)} compact />
          <MetaRow label={t("Channels")} value={String(channelCount)} compact />
          <MetaRow label={t("Skills")} value={t("{count} executable", { count: executableSkillCount })} compact />
          <MetaRow label={t("Memory")} value={memoryReady ? t("Memory on") : t("Memory preparing")} compact />
          <MetaRow label={t("MCP")} value={t("{count} authorized", { count: mcpBindingCount })} compact />
        </div>
      </section>
      <section>
        <div className="panel-title split">
          <span>
            <Upload size={15} />
            <h3>{t("Import guidance")}</h3>
          </span>
        </div>
        <p>{t("AGENTS.md and persona.md imports create drafts first. They cannot grant tools, approvals, secrets, or external-send permissions.")}</p>
      </section>
    </aside>
  );
}
