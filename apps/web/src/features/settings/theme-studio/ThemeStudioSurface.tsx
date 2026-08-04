import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../i18n.js";
import { useLingToast } from "../../../shared/ui/index.js";
import { Button, InlineFeedback } from "../../../shared/ui/index.js";
import { QuickThemeInputPanel } from "./QuickThemeInputPanel.js";
import { ThemeStudioLeaveDialog } from "./ThemeStudioLeaveDialog.js";
import { ThemeStudioPreviewPanel } from "./ThemeStudioPreviewPanel.js";
import { ThemeStudioProgress } from "./ThemeStudioProgress.js";
import { quickThemeIssueMessage } from "./quick-theme-view-models.js";
import { useQuickThemeStudioController } from "./useQuickThemeStudioController.js";

export function ThemeStudioSurface({ onBack }: { readonly onBack: () => void }): JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const controller = useQuickThemeStudioController();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const issueMessage = quickThemeIssueMessage(controller.state.issue, t);

  const requestBack = (): void => {
    if (controller.dirty) setLeaveOpen(true);
    else onBack();
  };

  const install = async (apply: boolean): Promise<void> => {
    const installed = await controller.install(apply);
    if (installed) {
      showToast({
        message: apply ? t("Theme installed and applied") : t("Theme installed"),
        scope: `theme:studio:${controller.state.draftId}`,
        tone: "success",
      });
    }
  };

  return (
    <section className="settings-theme-studio" data-ui2-theme-studio>
      <header className="settings-theme-studio-header">
        <Button leadingIcon={<ArrowLeft aria-hidden="true" />} size="sm" variant="ghost" onClick={requestBack}>
          {t("Back to themes")}
        </Button>
        <span>
          <strong>{t("Create theme")}</strong>
        </span>
      </header>

      <ThemeStudioProgress stage={controller.state.stage} hasSource={Boolean(controller.state.source)} />
      {issueMessage ? <InlineFeedback tone="danger">{issueMessage}</InlineFeedback> : null}

      <div className="settings-theme-studio-workspace">
        <QuickThemeInputPanel controller={controller} />
        <ThemeStudioPreviewPanel state={controller.state} />
      </div>

      <footer className="settings-theme-studio-actions">
        {controller.restoring ? <span>{t("Restoring local draft")}</span> : null}
        <Button disabled={!controller.canPublish} onClick={() => void install(false)}>
          {t("Install only")}
        </Button>
        <Button
          disabled={!controller.canPublish}
          loading={controller.state.stage === "publishing"}
          loadingLabel={t("Installing theme")}
          variant="primary"
          onClick={() => void install(true)}
        >
          {t("Install and use")}
        </Button>
      </footer>

      <ThemeStudioLeaveDialog
        open={leaveOpen}
        onCancel={() => setLeaveOpen(false)}
        onDiscard={() => {
          setLeaveOpen(false);
          onBack();
        }}
      />
    </section>
  );
}
