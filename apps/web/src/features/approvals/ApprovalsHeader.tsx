import { IconButton } from "../../shared/ui/index.js";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";

export function ApprovalsHeader({
  isLoading,
  pendingCount,
  repairScoped,
  onRefresh,
}: {
  readonly isLoading: boolean;
  readonly pendingCount: number;
  readonly repairScoped: boolean;
  readonly onRefresh: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <header className="approvals-ui2-header">
      <span className="approvals-ui2-title">
        <ShieldCheck aria-hidden="true" size={18} />
        <span>
          <h2 id="approvals-title">{repairScoped ? t("Approval requests") : t("Inbox")}</h2>
          <small>{t("{count} pending", { count: pendingCount })}</small>
        </span>
      </span>
      <IconButton
        icon={RefreshCw}
        label={t("Refresh")}
        loading={isLoading}
        onClick={onRefresh}
        variant="secondary"
      />
    </header>
  );
}
