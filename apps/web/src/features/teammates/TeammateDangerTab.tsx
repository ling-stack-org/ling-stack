import { Loader2, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { AiTeammate } from "../../types.js";

export function TeammateDangerTab({
  teammate,
  hardDeleteReason,
  hardDeleting,
  canHardDelete,
  onHardDeleteReasonChange,
  onDisableTeammate,
  onHardDeleteTeammate,
}: {
  readonly teammate: AiTeammate;
  readonly hardDeleteReason: string;
  readonly hardDeleting: boolean;
  readonly canHardDelete: boolean;
  readonly onHardDeleteReasonChange: (value: string) => void;
  readonly onDisableTeammate: (teammateId: string) => void | Promise<void>;
  readonly onHardDeleteTeammate: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-list-panel teammate-danger-panel" aria-label={t("Danger zone")}>
      <div className="panel-title split">
        <span>
          <Trash2 size={16} />
          <h2>{t("Danger zone")}</h2>
        </span>
        <small>{t("Private data boundary")}</small>
      </div>
      <article className="teammate-danger-zone teammate-danger-card">
        <span>
          <strong>{t("Disable teammate")}</strong>
          <small>{t("Soft disable hides the teammate from normal use but keeps durable data recoverable.")}</small>
        </span>
        <button className="secondary-button danger" type="button" onClick={() => void onDisableTeammate(teammate.id)}>
          {t("Disable")}
        </button>
      </article>
      <article className="teammate-danger-zone teammate-danger-card">
        <span>
          <strong>{t("Hard delete private data")}</strong>
          <small>{t("Deletes private chat, private attachments, avatar, teammate memory, and private bindings. Channel and run history keep a deleted teammate reference.")}</small>
        </span>
        <input value={hardDeleteReason} onChange={(event) => onHardDeleteReasonChange(event.target.value)} placeholder={t("Reason")} />
        <button className="secondary-button danger" type="button" onClick={() => void onHardDeleteTeammate()} disabled={hardDeleting || !canHardDelete}>
          {hardDeleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
          {t("Hard delete")}
        </button>
      </article>
    </section>
  );
}
