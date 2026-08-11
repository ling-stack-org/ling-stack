import { RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback } from "../../shared/ui/index.js";
import type { CouncilMutationProjection } from "./useCouncilCreateCloneController.js";

export function CouncilMutationProjectionStatus({
  projection,
  repairBusy,
  onRepair,
}: {
  readonly projection?: CouncilMutationProjection;
  readonly repairBusy: boolean;
  readonly onRepair: () => void | Promise<void>;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (!projection) return null;
  if (projection.phase !== "stale") {
    return (
      <InlineFeedback className="council-projection-feedback" tone="info" title={t("Refreshing council list")}>
        {t("Waiting for {name} to appear in the authoritative council list.", { name: projection.displayName })}
      </InlineFeedback>
    );
  }
  return (
    <InlineFeedback className="council-projection-feedback" tone="warning" title={t("Council list is stale")}>
      <span>{t("The council was saved, but this list could not be refreshed.")}</span>
      <Button
        leadingIcon={<RefreshCw />}
        loading={repairBusy}
        loadingLabel={t("Repairing council list...")}
        onClick={() => void onRepair()}
        size="sm"
      >
        {t("Repair council list")}
      </Button>
    </InlineFeedback>
  );
}
