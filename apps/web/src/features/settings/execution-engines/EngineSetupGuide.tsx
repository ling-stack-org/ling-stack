import type { ExternalExecutionEngineId } from "@ling-stack/contracts";
import { ExternalLink } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { Button } from "../../../shared/ui/index.js";
import { engineGuideUrl } from "./engine-guidance.js";

export function EngineSetupGuide({ engineId }: { readonly engineId: ExternalExecutionEngineId }): React.JSX.Element {
  const { t } = useI18n();
  return <Button asChild size="sm" variant="ghost" leadingIcon={<ExternalLink />}>
    <a href={engineGuideUrl(engineId)} target="_blank" rel="noopener noreferrer" data-desktop-window-no-drag="true">
      {engineId === "openclaw-acp" ? t("Open official guide") : t("Installation guide")}
    </a>
  </Button>;
}
