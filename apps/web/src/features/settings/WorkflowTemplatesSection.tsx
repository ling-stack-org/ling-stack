import { useRef } from "react";
import type { AiTeammate, Channel } from "@ling-stack/contracts";
import { Plus, RefreshCw, Upload } from "lucide-react";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, IconButton, InlineFeedback } from "../../shared/ui/index.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import type { WorkflowTemplateAuthoringController } from "./workflow-template-authoring-controller.js";
import { WorkflowTemplateEditor } from "./WorkflowTemplateEditor.js";
import { WorkflowTemplateList } from "./WorkflowTemplateList.js";

export function WorkflowTemplatesSection({ controller, channels, teammates, t }: {
  readonly controller: WorkflowTemplateAuthoringController;
  readonly channels: readonly Channel[];
  readonly teammates: readonly AiTeammate[];
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <section className="workflow-templates workflow-template-stack" aria-label={t("Workflow templates")} data-ui2-workflow-templates="">
      <header className="workflow-template-section-head">
        <h3>{t("Workflow templates")}</h3>
        <div className="workflow-template-actions">
          <IconButton icon={RefreshCw} label={t("Refresh workflow templates")} disabled={Boolean(controller.busy) || controller.loading} onClick={() => void controller.refresh()} />
          <IconButton icon={Upload} label={t("Import template JSON")} disabled={Boolean(controller.busy)} onClick={() => fileInput.current?.click()} />
          <input ref={fileInput} type="file" accept="application/json,.json" hidden data-ling-control-native="true" aria-label={t("Template JSON file")} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void controller.importFile(file);
          }} />
          <Button size="sm" leadingIcon={<Plus size={14} />} disabled={Boolean(controller.busy)} onClick={controller.newTemplate}>{t("New template")}</Button>
        </div>
      </header>
      {controller.listError ? <InlineFeedback tone="danger">{controller.listError}</InlineFeedback> : null}
      {controller.error ? <InlineFeedback tone="danger">{controller.error}</InlineFeedback> : null}
      {controller.session ? <WorkflowTemplateEditor controller={controller} channels={channels} teammates={teammates} t={t} />
        : <WorkflowTemplateList entries={controller.entries} loading={controller.loading} disabled={Boolean(controller.busy)} onSelect={controller.selectEntry} t={t} />}
    </section>
  );
}

export function WorkflowTemplateDiscardDialog({ controller, t }: {
  readonly controller: WorkflowTemplateAuthoringController;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  return (
    <Dialog open={controller.discardConfirmation} onOpenChange={(open) => { if (!open) controller.continueEditing(); }}>
      <DialogContent size="sm" data-ui2-workflow-template-discard="">
        <DialogHeader title={t("Discard unsaved changes?")} closeLabel={t("Continue editing")} />
        <DialogBody><p>{controller.session?.draft.template.name || controller.session?.draft.template.id}</p></DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" onClick={controller.continueEditing}>{t("Continue editing")}</Button>
          <Button size="sm" variant="danger" onClick={controller.confirmDiscard}>{t("Discard changes")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
