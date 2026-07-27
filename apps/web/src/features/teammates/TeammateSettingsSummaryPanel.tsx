import { UserCircle } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { DataRow } from "../../shared/ui/index.js";
import type { AiTeammate } from "../../types.js";
import { approvalProfileText } from "./helpers.js";

export function TeammateSettingsSummaryPanel({
  teammate,
  modelLabel,
  modelProviderLabel,
  channelCount,
  executableSkillCount,
  memoryReady,
  mcpBindingCount,
}: {
  readonly teammate: AiTeammate;
  readonly modelLabel: string;
  readonly modelProviderLabel: string;
  readonly channelCount: number;
  readonly executableSkillCount: number;
  readonly memoryReady: boolean;
  readonly mcpBindingCount: number;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <aside className="teammate-settings-summary-panel" aria-label={t("Configuration summary")}>
      <section>
        <div className="teammate-settings-summary-heading">
          <UserCircle size={15} />
          <h3>{t("Configuration summary")}</h3>
        </div>
        <div className="teammate-summary-list">
          <SummaryRow label={t("Provider")} value={modelProviderLabel} />
          <SummaryRow label={t("Model")} value={modelLabel} />
          <SummaryRow label={t("Approval")} value={approvalProfileText(teammate.approvalProfile, t)} />
          <SummaryRow label={t("Channels")} value={String(channelCount)} />
          <SummaryRow label={t("Skills")} value={t("{count} executable", { count: executableSkillCount })} />
          <SummaryRow label={t("Memory")} value={memoryReady ? t("Memory on") : t("Memory preparing")} />
          <SummaryRow label={t("MCP")} value={t("{count} authorized", { count: mcpBindingCount })} />
        </div>
      </section>
    </aside>
  );
}

function SummaryRow({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <DataRow
      compact
      className="teammate-summary-row"
      identity={<span className="teammate-summary-label">{label}</span>}
      status={<span className="teammate-summary-value" title={value}>{value}</span>}
    />
  );
}
