import { Check, Circle, FolderKanban, Wrench } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import { firstRunReady, firstRunSteps } from "./first-run-view-models.js";
import type { FirstRunController } from "./useFirstRunController.js";

export function FirstRunDialog({ controller }: { readonly controller: FirstRunController }): JSX.Element {
  const { t } = useI18n();
  const ready = firstRunReady(controller.readiness);
  const content = stepContent(controller, t);

  return (
    <Dialog open={controller.open} onOpenChange={(open) => { if (!open) controller.skip(); }}>
      <DialogContent className="first-run-dialog" size="md">
        <DialogHeader
          closeLabel={t("Skip for now")}
          description={t("A short setup check. You can skip it and keep using Ling.")}
          title={t("Get started with Ling")}
        />
        <DialogBody>
          <ol className="first-run-dialog-steps" aria-label={t("Setup steps")}>
            {firstRunSteps(controller.readiness, t).map((step) => (
              <li key={step.id} aria-current={controller.step === step.id ? "step" : undefined} data-ready={step.ready ? "true" : undefined}>
                {step.ready ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
          <section className="first-run-dialog-content" aria-live="polite">
            {content.icon}
            <span>
              <h2>{content.title}</h2>
              <p>{content.body}</p>
            </span>
          </section>
          {!ready && controller.step === "check" ? (
            <InlineFeedback tone="warning">{t("Setup is not complete yet. You can repair it now or continue later.")}</InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={controller.skip}>{t("Skip for now")}</Button>
          {controller.step === "workspace" ? (
            <Button variant="primary" onClick={controller.next}>{t("Continue")}</Button>
          ) : controller.step === "model" && !controller.readiness.hasReadyProvider ? (
            <Button leadingIcon={<Wrench aria-hidden="true" />} variant="primary" onClick={controller.openModelWorkbench}>
              {t("Open Model Workbench")}
            </Button>
          ) : controller.step === "model" ? (
            <Button variant="primary" onClick={controller.next}>{t("Continue")}</Button>
          ) : ready ? (
            <Button variant="primary" onClick={controller.complete}>{t("Start using Ling")}</Button>
          ) : (
            <Button variant="primary" onClick={controller.recheck}>{t("Check again")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function stepContent(controller: FirstRunController, t: (key: string) => string) {
  if (controller.step === "workspace") {
    return controller.readiness.workspaceReady && controller.readiness.daemonReady
      ? { icon: <FolderKanban aria-hidden="true" />, title: t("Workspace is ready"), body: t("Ling can use the current workspace. Continue to check your model.") }
      : { icon: <FolderKanban aria-hidden="true" />, title: t("Workspace needs attention"), body: t("The current workspace is not ready yet. You can continue and configure it later.") };
  }
  if (controller.step === "model") {
    return controller.readiness.hasReadyProvider
      ? { icon: <Check aria-hidden="true" />, title: t("Model is ready"), body: t("A checked chat model is available for conversations.") }
      : { icon: <Wrench aria-hidden="true" />, title: t("Connect a model"), body: t("Open Model Workbench to add or repair a chat model. Your existing settings stay in one place.") };
  }
  return firstRunReady(controller.readiness)
    ? { icon: <Check aria-hidden="true" />, title: t("Ling is ready"), body: t("Workspace and model checks are complete.") }
    : { icon: <Wrench aria-hidden="true" />, title: t("One more step"), body: t("Finish the missing setup when you are ready. Ling will remain available.") };
}
