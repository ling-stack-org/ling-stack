import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  SegmentedControl,
  SegmentedControlItem,
} from "../../shared/ui/index.js";
import type {
  AutomationContextPreview,
  AutomationDefinition,
  AutomationDraft,
  BuiltinAutomationTemplate,
  Channel,
  CreateAutomationRequest,
  LingThread,
  ProviderPreset,
} from "../../types.js";
import type { AutomationCreateKind, AutomationDraftMutationKind } from "../../domains/automations/use-automations-domain.js";
import { AutomationChatDraftForm } from "./AutomationChatDraftForm.js";
import { AutomationManualForm } from "./AutomationManualForm.js";
import { AutomationTemplateStep } from "./AutomationTemplateStep.js";
import {
  defaultAutomationFormValue,
  draftAutomationFormValue,
  templateAutomationFormValue,
  type AutomationFormValue,
} from "./automation-form-models.js";
import type { AutomationCreateMode } from "./useAutomationsPageController.js";
import type { AutomationTranslate } from "./automation-view-models.js";

export function AutomationCreateDialog({
  channels,
  createAction,
  createError,
  draftActionById,
  draftErrorById,
  drafts,
  draftPreviewById,
  mode,
  open,
  providers,
  t,
  templates,
  threadTitleById,
  threads,
  threadsLoading,
  cwd,
  onConfirmDraft,
  onCreateAutomation,
  onCreateChatDraft,
  onModeChange,
  onOpenChange,
  onPreviewDraft,
  onUpdateDraft,
}: {
  readonly channels: readonly Channel[];
  readonly createAction: AutomationCreateKind;
  readonly createError: string;
  readonly draftActionById: Readonly<Record<string, AutomationDraftMutationKind | undefined>>;
  readonly draftErrorById: Readonly<Record<string, string | undefined>>;
  readonly drafts: readonly AutomationDraft[];
  readonly draftPreviewById: Readonly<Record<string, AutomationContextPreview>>;
  readonly mode: AutomationCreateMode;
  readonly open: boolean;
  readonly providers: readonly ProviderPreset[];
  readonly t: AutomationTranslate;
  readonly templates: readonly BuiltinAutomationTemplate[];
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly threads: readonly LingThread[];
  readonly threadsLoading: boolean;
  readonly cwd: string;
  readonly onConfirmDraft: (draftId: string) => Promise<AutomationDefinition | undefined>;
  readonly onCreateAutomation: (request: CreateAutomationRequest) => Promise<AutomationDefinition | undefined>;
  readonly onCreateChatDraft: (prompt: string) => Promise<AutomationDraft | undefined>;
  readonly onModeChange: (mode: AutomationCreateMode) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPreviewDraft: (draftId: string) => Promise<AutomationContextPreview | undefined>;
  readonly onUpdateDraft: (draftId: string, partial: Partial<CreateAutomationRequest>) => Promise<AutomationDraft | undefined>;
}): JSX.Element {
  const makeDefaultForm = () => defaultAutomationFormValue({ channels, cwd, providers });
  const [formValue, setFormValue] = useState<AutomationFormValue>(makeDefaultForm);
  const [chatPrompt, setChatPrompt] = useState("");
  const [chatDraftId, setChatDraftId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(templates[0]?.id ?? "");
  const wasOpenRef = useRef(false);
  const activeDraft = drafts.find((draft) => draft.id === chatDraftId);
  const draftAction = activeDraft ? draftActionById[activeDraft.id] : undefined;
  const busy = Boolean(createAction || draftAction);
  const scopedError = activeDraft ? draftErrorById[activeDraft.id] ?? createError : createError;

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setFormValue(makeDefaultForm());
      setChatPrompt("");
      setChatDraftId("");
      setSelectedTemplateId(templates[0]?.id ?? "");
    }
    wasOpenRef.current = open;
  }, [open]);

  async function submitManual(request: CreateAutomationRequest): Promise<void> {
    if (chatDraftId) {
      const updated = await onUpdateDraft(chatDraftId, request);
      if (updated) onModeChange("chat");
      return;
    }
    const created = await onCreateAutomation(request);
    if (created) onOpenChange(false);
  }

  async function createChatDraft(): Promise<void> {
    const created = await onCreateChatDraft(chatPrompt);
    if (created) setChatDraftId(created.id);
  }

  async function confirmChatDraft(): Promise<void> {
    if (!activeDraft) return;
    const created = await onConfirmDraft(activeDraft.id);
    if (created) onOpenChange(false);
  }

  return (
    <Dialog busy={busy} open={open} onOpenChange={onOpenChange}>
      <DialogContent className="automation-ui2-create-dialog" size="lg">
        <DialogHeader closeLabel={t("Close")} title={t("New automation")} />
        <DialogBody>
          <SegmentedControl
            aria-label={t("Choose creation mode")}
            className="automation-ui2-create-modes"
            size="sm"
            value={mode}
            onValueChange={(value) => onModeChange(value as AutomationCreateMode)}
          >
            <SegmentedControlItem value="template">{t("Use template")}</SegmentedControlItem>
            <SegmentedControlItem value="manual">{t("Manual setup")}</SegmentedControlItem>
            <SegmentedControlItem value="chat">{t("Create from conversation")}</SegmentedControlItem>
          </SegmentedControl>

          {mode === "template" ? (
            <AutomationTemplateStep
              selectedTemplateId={selectedTemplateId}
              t={t}
              templates={templates}
              onReview={(template) => {
                const templateValue = templateAutomationFormValue(template, makeDefaultForm());
                setFormValue({
                  ...templateValue,
                  prompt: t(templateValue.prompt),
                  title: t(templateValue.title),
                });
                onModeChange("manual");
              }}
              onSelect={setSelectedTemplateId}
            />
          ) : mode === "manual" ? (
            <AutomationManualForm
              busy={busy}
              channels={channels}
              error={scopedError}
              providers={providers}
              submitLabel={chatDraftId ? t("Save") : t("Create automation")}
              t={t}
              threads={threads}
              threadsLoading={threadsLoading}
              value={formValue}
              onCancel={() => onOpenChange(false)}
              onChange={setFormValue}
              onSubmit={(request) => void submitManual(request)}
            />
          ) : (
            <AutomationChatDraftForm
              busy={busy}
              channels={channels}
              draft={activeDraft}
              error={scopedError}
              preview={activeDraft ? draftPreviewById[activeDraft.id] : undefined}
              prompt={chatPrompt}
              t={t}
              threadTitleById={threadTitleById}
              onCancel={() => onOpenChange(false)}
              onConfirm={() => void confirmChatDraft()}
              onCreateDraft={() => void createChatDraft()}
              onPreview={() => activeDraft ? void onPreviewDraft(activeDraft.id) : undefined}
              onPromptChange={setChatPrompt}
              onRepair={() => {
                if (!activeDraft) return;
                setFormValue(draftAutomationFormValue(activeDraft, makeDefaultForm()));
                onModeChange("manual");
              }}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
