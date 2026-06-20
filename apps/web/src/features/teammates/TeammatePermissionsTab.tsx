import { ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import type { AiTeammate } from "../../types.js";
import { approvalProfileText } from "./helpers.js";

export function TeammatePermissionsTab({
  teammate,
}: {
  readonly teammate: AiTeammate;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-list-panel teammate-permissions-panel" aria-label={t("Permissions")}>
      <div className="panel-title split">
        <span>
          <ShieldCheck size={16} />
          <h2>{t("Permissions")}</h2>
        </span>
        <small>{approvalProfileText(teammate.approvalProfile, t)}</small>
      </div>
      <div className="teammate-data-list">
        <article className="teammate-data-row">
          <span>
            <strong>{t("Approval profile")}</strong>
            <small>{approvalProfileText(teammate.approvalProfile, t)}</small>
          </span>
          <StatusBadge status="policy" />
        </article>
        <article className="teammate-data-row">
          <span>
            <strong>{t("Allowed tools")}</strong>
            <small>{teammate.allowedTools.length ? teammate.allowedTools.join(", ") : t("No tools")}</small>
          </span>
          <StatusBadge status={teammate.allowedTools.length ? "active" : "none"} />
        </article>
        <article className="teammate-data-row">
          <span>
            <strong>{t("Persona boundary")}</strong>
            <small>{t("Persona cannot grant tools, approvals, or secrets; Skill permissions are enforced by binding and policy checks.")}</small>
          </span>
          <StatusBadge status="enforced" />
        </article>
      </div>
    </section>
  );
}
