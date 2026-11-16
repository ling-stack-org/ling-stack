import type { Channel } from "@ling-stack/contracts";
import { FilePlus2, ScanLine } from "lucide-react";
import { Button, Field, InlineFeedback, Select, Textarea } from "../../shared/ui/index.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import type { WorkflowTemplateAuthoringController } from "./workflow-template-authoring-controller.js";

export function WorkflowTemplatePreview({ controller, channels, t }: {
  readonly controller: WorkflowTemplateAuthoringController;
  readonly channels: readonly Channel[];
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const { session, busy, preview } = controller;
  if (!session) return <></>;
  const previewDisabled = Boolean(busy || session.conflict || !controller.validation.template || !controller.channelId || !controller.objective.trim());
  return (
    <section className="workflow-template-preview workflow-template-stack" aria-label={t("Compile preview")}>
      <h4>{t("Compile preview")}</h4>
      <Field label={t("Channel")} required>
        <Select value={controller.channelId} disabled={Boolean(busy)} onChange={(event) => controller.setChannelId(event.currentTarget.value)}>
          <option value="">{t("Select channel")}</option>
          {channels.map((channel) => <option key={channel.id} value={channel.id} disabled={channel.status !== "active"}>{channel.name}</option>)}
        </Select>
      </Field>
      <Field label={t("Objective")} required>
        <Textarea rows={3} value={controller.objective} disabled={Boolean(busy)} onChange={(event) => controller.setObjective(event.currentTarget.value)} />
      </Field>
      <div className="workflow-template-actions">
        <Button size="sm" variant="secondary" leadingIcon={<ScanLine size={14} />} loading={busy === "previewing"}
          disabled={previewDisabled} onClick={() => void controller.compilePreview()}>{t("Compile preview")}</Button>
        <Button size="sm" leadingIcon={<FilePlus2 size={14} />} loading={busy === "creating"}
          disabled={Boolean(busy) || !controller.canCreate} onClick={() => void controller.createWorkflow()}>{t("Create workflow")}</Button>
      </div>
      {preview ? (
        <div className="workflow-template-compiled" aria-label={t("Compiled steps")}>
          <dl className="workflow-template-pin">
            <dt>{t("Version")}</dt><dd>{preview.result.templatePin.version}</dd>
            <dt>{t("Template digest")}</dt><dd><code>{preview.result.templatePin.digest}</code></dd>
            <dt>{t("Graph fingerprint")}</dt><dd><code>{preview.result.graphFingerprint}</code></dd>
          </dl>
          <ol className="workflow-template-compiled-steps">
            {preview.result.steps.map((step) => (
              <li key={step.templateStepId}>
                <strong>{step.title}</strong><code>{step.templateStepId}</code>
                <dl>
                  <dt>{t("Member")}</dt><dd>{step.toParticipantLabel} <code>{step.toParticipantId}</code></dd>
                  <dt>{t("Depends on")}</dt><dd>{step.dependsOn.length ? step.dependsOn.join(", ") : t("None")}</dd>
                  <dt>{t("Required tools")}</dt><dd>{step.requiredTools.length ? step.requiredTools.join(", ") : t("None")}</dd>
                  <dt>{t("Runner")}</dt><dd>{step.runnerId}</dd>
                  <dt>{t("Provider")}</dt><dd>{step.providerPresetId ?? t("None")}</dd>
                  <dt>{t("Side-effect class")}</dt><dd>{step.sideEffectClass ?? t("Unclassified")}</dd>
                  {step.parallelPolicy ? <><dt>{t("Parallel policy")}</dt><dd><code>{JSON.stringify(step.parallelPolicy)}</code></dd></> : null}
                </dl>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {controller.createdWorkflowId ? <InlineFeedback tone="success" title={t("Workflow created")}><code>{controller.createdWorkflowId}</code></InlineFeedback> : null}
    </section>
  );
}
