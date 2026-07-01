import { useState } from "react";
import { CircleAlert, Save, Workflow, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  MessageBodyRenderer,
} from "../../shared/conversation/index.js";
import type { ProposedPlanArtifact } from "../../types.js";

export interface WorkflowConversionDraft {
  readonly workflowTitle?: string;
  readonly workflowSteps?: readonly string[];
}

export interface WorkflowConversionPreviewDrawerProps {
  readonly plan: ProposedPlanArtifact;
  readonly cwd: string;
  readonly busy: boolean;
  readonly onConfirm: (plan: ProposedPlanArtifact, draft?: WorkflowConversionDraft) => void;
  readonly onClose: () => void;
}

export type WorkflowConversionPreviewDialogProps = WorkflowConversionPreviewDrawerProps;

export function WorkflowConversionPreviewDrawer({
  plan,
  cwd,
  busy,
  onConfirm,
  onClose,
}: WorkflowConversionPreviewDrawerProps): JSX.Element {
  const { t } = useI18n();
  const steps = deriveWorkflowPreviewSteps(plan.bodyMarkdown);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(plan.title);
  const [draftStepsText, setDraftStepsText] = useState(steps.map((step, index) => `${index + 1}. ${step}`).join("\n"));
  const draftSteps = parseWorkflowDraftSteps(draftStepsText);

  return (
    <div className="environment-commit-dialog-backdrop workflow-conversion-preview-backdrop">
      <section className="environment-commit-dialog workflow-conversion-preview-dialog" role="dialog" aria-modal="true" aria-label={t("Workflow conversion preview")}>
        <header className="environment-commit-dialog-head">
          <span>
            <Workflow size={17} />
            <strong>{t("Workflow conversion preview")}</strong>
          </span>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label={t("Close")} title={t("Close")}>
            <X size={15} />
          </button>
        </header>
        {editing ? (
          <label className="workflow-preview-field">
            <span>{t("Draft title")}</span>
            <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} disabled={busy} aria-label={t("Draft title")} />
          </label>
        ) : (
          <div className="workflow-preview-summary">
            <strong>{plan.title}</strong>
            <small>{t("Draft workflow")} · {plan.sourceMessageId ? t("Source message") : t("Source unavailable")}</small>
          </div>
        )}
        <section className="workflow-preview-section" aria-label={t("Proposed steps")}>
          <h3>{t("Proposed steps")}</h3>
          {editing ? (
            <textarea
              className="workflow-preview-steps-input"
              value={draftStepsText}
              onChange={(event) => setDraftStepsText(event.target.value)}
              disabled={busy}
              aria-label={t("Draft workflow steps")}
              rows={7}
            />
          ) : (
            <ol>
              {steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}
            </ol>
          )}
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
        <footer className="environment-commit-actions">
          <button className="secondary-button" type="button" onClick={() => setEditing((value) => !value)} disabled={busy}>
            {editing ? t("Preview") : t("Edit draft")}
          </button>
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => onConfirm(plan, editing ? {
              workflowTitle: draftTitle.trim() || plan.title,
              workflowSteps: draftSteps.length > 0 ? draftSteps : steps,
            } : undefined)}
            disabled={busy}
          >
            <Save size={15} />
            {busy ? t("Saving...") : t("Save draft workflow")}
          </button>
        </footer>
      </section>
    </div>
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
