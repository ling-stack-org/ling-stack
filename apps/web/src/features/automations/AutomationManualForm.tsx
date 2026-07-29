import { ChevronDown } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DialogFooter,
  Field,
  InlineFeedback,
  Input,
  Select,
  Textarea,
} from "../../shared/ui/index.js";
import type { Channel, CreateAutomationRequest, LingThread, ProviderPreset } from "../../types.js";
import { AutomationScheduleFields } from "./AutomationScheduleFields.js";
import {
  automationTargetOptions,
  buildAutomationRequest,
  validateAutomationForm,
  type AutomationFormValue,
} from "./automation-form-models.js";
import type { AutomationTranslate } from "./automation-view-models.js";

export function AutomationManualForm({
  busy,
  channels,
  error,
  providers,
  submitLabel,
  t,
  threads,
  threadsLoading,
  value,
  onCancel,
  onChange,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly channels: readonly Channel[];
  readonly error: string;
  readonly providers: readonly ProviderPreset[];
  readonly submitLabel: string;
  readonly t: AutomationTranslate;
  readonly threads: readonly LingThread[];
  readonly threadsLoading: boolean;
  readonly value: AutomationFormValue;
  readonly onCancel: () => void;
  readonly onChange: (value: AutomationFormValue) => void;
  readonly onSubmit: (request: CreateAutomationRequest) => void;
}): JSX.Element {
  const [submitted, setSubmitted] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const targetRef = useRef<HTMLSelectElement>(null);
  const scheduleRef = useRef<HTMLDivElement>(null);
  const errors = submitted ? validateAutomationForm(value, t("Required")) : {};
  const targetOptions = useMemo(() => automationTargetOptions({ channels, threads }), [channels, threads]);
  const chatProviders = providers.filter((provider) => provider.enabled && provider.capabilities.includes("chat"));

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setSubmitted(true);
    const nextErrors = validateAutomationForm(value, t("Required"));
    if (nextErrors.title) titleRef.current?.focus();
    else if (nextErrors.prompt) promptRef.current?.focus();
    else if (nextErrors.target) targetRef.current?.focus();
    else if (nextErrors.schedule) scheduleRef.current?.scrollIntoView({ block: "nearest" });
    if (Object.values(nextErrors).some(Boolean)) return;
    onSubmit(buildAutomationRequest(value, providers));
  }

  return (
    <form className="automation-ui2-manual-form" noValidate onSubmit={submit}>
      {error ? <InlineFeedback title={t("Setup needs attention")} tone="danger">{error}</InlineFeedback> : null}
      <div className="automation-ui2-form-grid">
        <Field error={errors.title} label={t("Automation name")} required>
          <Input
            ref={titleRef}
            disabled={busy}
            onChange={(event) => onChange({ ...value, title: event.target.value })}
            placeholder={t("Automation title placeholder")}
            value={value.title}
          />
        </Field>
        <Field error={errors.prompt} label={t("Execution action")} required>
          <Textarea
            ref={promptRef}
            disabled={busy}
            onChange={(event) => onChange({ ...value, prompt: event.target.value })}
            placeholder={t("Automation prompt placeholder")}
            rows={5}
            value={value.prompt}
          />
        </Field>
        <Field error={errors.target} label={t("Target")} required>
          <Select
            ref={targetRef}
            disabled={busy || threadsLoading}
            onChange={(event) => onChange({ ...value, targetId: event.target.value })}
            value={value.targetId}
          >
            {targetOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
          </Select>
        </Field>
        <Field label={t("Model")}>
          <Select
            disabled={busy}
            onChange={(event) => onChange({ ...value, providerPresetId: event.target.value })}
            value={value.providerPresetId}
          >
            <option value="">{t("Select model")}</option>
            {chatProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.displayName} · {provider.model}</option>
            ))}
          </Select>
        </Field>
        <div ref={scheduleRef} className="automation-ui2-form-span">
          <AutomationScheduleFields
            disabled={busy}
            error={errors.schedule}
            t={t}
            value={value.schedule}
            onChange={(schedule) => onChange({ ...value, schedule })}
          />
        </div>
      </div>

      <Collapsible className="automation-ui2-advanced" open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button trailingIcon={<ChevronDown aria-hidden="true" size={15} />} variant="ghost">
            {t("Advanced configuration")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="automation-ui2-advanced-grid">
            <Field label={t("Runtime")}>
              <Select
                disabled={busy || value.targetId.startsWith("thread:")}
                onChange={(event) => onChange({ ...value, runtime: event.target.value as AutomationFormValue["runtime"] })}
                value={value.runtime}
              >
                <option value="local">{t("Local")}</option>
                <option value="worktree">{t("Worktree")}</option>
              </Select>
            </Field>
            <Field label={t("Reasoning")}>
              <Select
                disabled={busy}
                onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value as AutomationFormValue["reasoningEffort"] })}
                value={value.reasoningEffort}
              >
                <option value="low">{t("Low")}</option>
                <option value="medium">{t("Medium")}</option>
                <option value="high">{t("High")}</option>
                <option value="xhigh">{t("XHigh")}</option>
              </Select>
            </Field>
            <Checkbox
              checked={value.outputArtifact}
              disabled={busy}
              label={`${t("Output")} · ${t("Artifact")}`}
              onChange={(event) => onChange({ ...value, outputArtifact: event.target.checked })}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <DialogFooter>
        <Button disabled={busy} onClick={onCancel} variant="ghost">{t("Cancel")}</Button>
        <Button loading={busy} loadingLabel={submitLabel} type="submit" variant="primary">{submitLabel}</Button>
      </DialogFooter>
    </form>
  );
}
