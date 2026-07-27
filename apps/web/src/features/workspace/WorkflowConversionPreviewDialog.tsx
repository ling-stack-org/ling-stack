import { useMemo, useRef, useState } from "react";
import { CircleAlert, Save } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  MessageBodyRenderer,
} from "../../shared/conversation/index.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Select,
  Textarea,
} from "../../shared/ui/index.js";
import type { ProposedPlanArtifact } from "../../types.js";
import {
  inferWorkflowOwnerPreviews,
  type WorkflowOwnerConfidence,
  type WorkflowOwnerInferenceHistoryStep,
  type WorkflowOwnerInferenceTeammate,
} from "./workflow-owner-inference.js";

export interface WorkflowConversionStepPreviewDraft {
  readonly title: string;
  readonly ownerId?: string;
  readonly ownerLabel?: string;
  readonly ownerConfidence?: WorkflowOwnerConfidence;
  readonly ownerReason?: string;
  readonly sourceSignals?: readonly string[];
}

export interface WorkflowConversionDraft {
  readonly workflowTitle?: string;
  readonly workflowSteps?: readonly string[];
  readonly workflowStepPreviews?: readonly WorkflowConversionStepPreviewDraft[];
}

export interface WorkflowConversionPreviewDrawerProps {
  readonly plan: ProposedPlanArtifact;
  readonly cwd: string;
  readonly busy: boolean;
  readonly teammates: readonly WorkflowOwnerInferenceTeammate[];
  readonly historicalWorkflowSteps: readonly WorkflowOwnerInferenceHistoryStep[];
  readonly onConfirm: (plan: ProposedPlanArtifact, draft?: WorkflowConversionDraft) => void;
  readonly onClose: () => void;
}

export type WorkflowConversionPreviewDialogProps = WorkflowConversionPreviewDrawerProps;

export function WorkflowConversionPreviewDrawer({
  plan,
  cwd,
  busy,
  teammates,
  historicalWorkflowSteps,
  onConfirm,
  onClose,
}: WorkflowConversionPreviewDrawerProps): JSX.Element {
  const { t } = useI18n();
  const steps = deriveWorkflowPreviewSteps(plan.bodyMarkdown);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(plan.title);
  const [draftStepsText, setDraftStepsText] = useState(steps.map((step, index) => `${index + 1}. ${step}`).join("\n"));
  const [ownerSelections, setOwnerSelections] = useState<Readonly<Record<number, string>>>({});
  const draftSteps = parseWorkflowDraftSteps(draftStepsText);
  const effectiveSteps = editing ? draftSteps.length > 0 ? draftSteps : steps : steps;
  const ownerPreviews = useMemo(
    () => inferWorkflowOwnerPreviews({ plan, steps: effectiveSteps, teammates, historicalWorkflowSteps }),
    [effectiveSteps, historicalWorkflowSteps, plan, teammates],
  );
  const ownerOptions = useMemo(() => uniqueOwnerOptions(teammates), [teammates]);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  function closeAndRestoreFocus(): void {
    const returnFocusTarget = returnFocusRef.current;
    onClose();
    globalThis.requestAnimationFrame(() => returnFocusTarget?.focus({ preventScroll: true }));
  }

  function selectedOwnerIdFor(index: number): string {
    const selected = ownerSelections[index];
    if (selected !== undefined) {
      return selected;
    }
    const preview = ownerPreviews[index];
    if (!preview || preview.ownerConfidence === "low" || preview.ownerConfidence === "none") {
      return "";
    }
    return preview.suggestedOwnerId ?? "";
  }

  function updateOwnerSelection(index: number, ownerId: string): void {
    setOwnerSelections((current) => ({ ...current, [index]: ownerId }));
  }

  function buildDraft(): WorkflowConversionDraft {
    return {
      workflowTitle: draftTitle.trim() || plan.title,
      workflowSteps: effectiveSteps,
      workflowStepPreviews: ownerPreviews.map((preview, index) => {
        const ownerId = selectedOwnerIdFor(index);
        const owner = ownerOptions.find((option) => option.id === ownerId);
        return {
          title: preview.title,
          ownerId: ownerId || undefined,
          ownerLabel: owner?.displayName ?? (ownerId ? preview.suggestedOwnerLabel : undefined),
          ownerConfidence: preview.ownerConfidence,
          ownerReason: preview.ownerReason,
          sourceSignals: preview.sourceSignals,
        };
      }),
    };
  }

  return (
    <Dialog open busy={busy} onOpenChange={(open) => !open && closeAndRestoreFocus()}>
      <DialogContent className="workflow-conversion-preview-dialog" size="md">
        <DialogHeader title={t("Workflow conversion preview")} closeLabel={t("Close")} />
        <DialogBody className="workflow-conversion-preview-body">
          {editing ? (
            <Field className="workflow-preview-field" label={t("Draft title")}>
              <Input
                containerClassName="workflow-preview-title-control"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                disabled={busy}
              />
            </Field>
          ) : (
            <div className="workflow-preview-summary">
              <strong>{plan.title}</strong>
              <small>{t("Draft workflow")} · {plan.sourceMessageId ? t("Source message") : t("Source unavailable")}</small>
            </div>
          )}
          <section className="workflow-preview-section" aria-label={t("Proposed steps")}>
            <h3>{t("Proposed steps")}</h3>
            {editing ? (
              <Textarea
                className="workflow-preview-steps-input"
                value={draftStepsText}
                onChange={(event) => {
                  setDraftStepsText(event.target.value);
                  setOwnerSelections({});
                }}
                disabled={busy}
                aria-label={t("Draft workflow steps")}
                rows={7}
              />
            ) : (
              <p className="workflow-preview-owner-note">{t("Owner suggestions are preview-only until you save this draft.")}</p>
            )}
            <ol className="workflow-preview-owner-list">
              {ownerPreviews.map((preview, index) => (
                <li key={`${index}:${preview.title}`} className="workflow-preview-owner-row">
                  <span className="workflow-preview-owner-title">{preview.title}</span>
                  <label className="workflow-preview-owner-select">
                    <span>{t("Owner")}</span>
                    <Select
                      size="sm"
                      value={selectedOwnerIdFor(index)}
                      onChange={(event) => updateOwnerSelection(index, event.target.value)}
                      disabled={busy}
                      aria-label={t("Owner for step {index}", { index: index + 1 })}
                    >
                      <option value="">{t("Unassigned")}</option>
                      {ownerOptions.map((owner) => (
                        <option key={owner.id} value={owner.id}>{owner.displayName}</option>
                      ))}
                    </Select>
                  </label>
                  <span className={`workflow-preview-confidence confidence-${preview.ownerConfidence}`}>
                    {ownerConfidenceLabel(preview.ownerConfidence, t)}
                  </span>
                  {preview.ownerReason ? <small>{preview.ownerReason}</small> : null}
                </li>
              ))}
            </ol>
          </section>
          <section className="workflow-preview-section" aria-label={t("Source plan")}>
            <h3>{t("Source plan")}</h3>
            <div className="workflow-preview-plan-body">
              <MessageBodyRenderer text={plan.bodyMarkdown} cwd={cwd} compact />
            </div>
          </section>
          <p className="workflow-preview-risk">
            <CircleAlert size={14} />
            <span>{t("Saving creates a draft workflow only. It does not start execution.")}</span>
          </p>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" onClick={() => setEditing((value) => !value)} disabled={busy}>
            {editing ? t("Preview") : t("Edit draft")}
          </Button>
          <Button autoFocus size="sm" variant="secondary" onClick={closeAndRestoreFocus} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<Save size={15} />}
            loading={busy}
            loadingLabel={t("Saving...")}
            onClick={() => onConfirm(plan, buildDraft())}
          >
            {busy ? t("Saving...") : t("Save draft workflow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const WorkflowConversionPreviewDialog = WorkflowConversionPreviewDrawer;

function parseWorkflowDraftSteps(value: string): readonly string[] {
  return value
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*]|\d+[.)])\s+/u, "").trim())
    .filter(Boolean)
    .slice(0, 50);
}

function deriveWorkflowPreviewSteps(markdown: string): readonly string[] {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const explicitSteps = lines
    .map((line) => /^(?:[-*]|\d+[.)])\s+(.+)$/u.exec(line)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, 8);
  if (explicitSteps.length > 0) {
    return explicitSteps;
  }
  const headingSteps = lines
    .map((line) => /^#{1,4}\s+(.+)$/u.exec(line)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, 8);
  if (headingSteps.length > 0) {
    return headingSteps;
  }
  return ["Review source plan", "Create draft workflow steps", "Assign owners before execution"];
}

function uniqueOwnerOptions(teammates: readonly WorkflowOwnerInferenceTeammate[]): readonly WorkflowOwnerInferenceTeammate[] {
  const seen = new Set<string>();
  const owners: WorkflowOwnerInferenceTeammate[] = [];
  for (const teammate of teammates) {
    if (!teammate.id || seen.has(teammate.id)) {
      continue;
    }
    seen.add(teammate.id);
    owners.push(teammate);
  }
  return owners;
}

function ownerConfidenceLabel(confidence: WorkflowOwnerConfidence, t: (key: string) => string): string {
  if (confidence === "high") {
    return t("High confidence");
  }
  if (confidence === "medium") {
    return t("Medium confidence");
  }
  if (confidence === "low") {
    return t("Low confidence");
  }
  return t("No owner signal");
}
