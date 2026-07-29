import { CircleAlert, Plus, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Field, Input, Select, Textarea } from "../../shared/ui/index.js";

export type ChannelExecutionProposalEditorAction =
  | "coordinated"
  | "consulted"
  | "reviewed"
  | "flagged_risk";

export interface ChannelExecutionProposalEditorStep<TSource = unknown> {
  readonly teammateId: string;
  readonly action: ChannelExecutionProposalEditorAction;
  readonly summary: string;
  readonly sources?: readonly TSource[];
}

export interface ChannelExecutionProposalEditorDraft<TSource = unknown> {
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteriaText: string;
  readonly shapingSummaryText: string;
  readonly shapingOpenQuestionsText: string;
  readonly shapingClarificationsText: string;
  readonly collaborationSteps: readonly ChannelExecutionProposalEditorStep<TSource>[];
}

export interface ChannelExecutionProposalEditorTeammate {
  readonly id: string;
  readonly label: string;
}

type ChannelExecutionProposalDraftPatch<TSource> = Partial<
  Omit<ChannelExecutionProposalEditorDraft<TSource>, "collaborationSteps">
>;

export interface ChannelExecutionProposalEditorProps<TSource = unknown> {
  readonly canRemoveStep: boolean;
  readonly disabled?: boolean;
  readonly draft: ChannelExecutionProposalEditorDraft<TSource>;
  readonly error?: string;
  readonly onAddStep: () => void;
  readonly onDraftChange: (patch: ChannelExecutionProposalDraftPatch<TSource>) => void;
  readonly onRemoveStep: (index: number) => void;
  readonly onStepChange: (
    index: number,
    patch: Partial<ChannelExecutionProposalEditorStep<TSource>>,
  ) => void;
  readonly teammates: readonly ChannelExecutionProposalEditorTeammate[];
}

const proposalStepActions: readonly ChannelExecutionProposalEditorAction[] = [
  "coordinated",
  "consulted",
  "reviewed",
  "flagged_risk",
];

export function ChannelExecutionProposalEditor<TSource>({
  canRemoveStep,
  disabled = false,
  draft,
  error,
  onAddStep,
  onDraftChange,
  onRemoveStep,
  onStepChange,
  teammates,
}: ChannelExecutionProposalEditorProps<TSource>): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="channel-proposal-edit-form">
      <Field className="channel-proposal-edit-field" label={t("Title")}>
        <Input
          disabled={disabled}
          value={draft.title}
          onChange={(event) => onDraftChange({ title: event.currentTarget.value })}
        />
      </Field>
      <Field className="channel-proposal-edit-field" label={t("Scope")}>
        <Textarea
          disabled={disabled}
          rows={4}
          value={draft.prompt}
          onChange={(event) => onDraftChange({ prompt: event.currentTarget.value })}
        />
      </Field>
      <Field className="channel-proposal-edit-field" label={t("Assignee")}>
        <Select
          disabled={disabled}
          size="md"
          value={draft.assigneeTeammateId}
          onChange={(event) => onDraftChange({ assigneeTeammateId: event.currentTarget.value })}
        >
          {teammates.map((teammate) => (
            <option key={teammate.id} value={teammate.id}>{teammate.label}</option>
          ))}
          {teammates.some((teammate) => teammate.id === draft.assigneeTeammateId) ? null : (
            <option value={draft.assigneeTeammateId}>
              {teammateLabel(draft.assigneeTeammateId, teammates, t("Deleted teammate"))}
            </option>
          )}
        </Select>
      </Field>
      <Field className="channel-proposal-edit-field" label={t("Acceptance criteria")}>
        <Textarea
          disabled={disabled}
          rows={3}
          value={draft.acceptanceCriteriaText}
          onChange={(event) => onDraftChange({ acceptanceCriteriaText: event.currentTarget.value })}
        />
      </Field>
      <Field className="channel-proposal-edit-field" label={t("Requirement summary")}>
        <Textarea
          disabled={disabled}
          rows={3}
          value={draft.shapingSummaryText}
          onChange={(event) => onDraftChange({ shapingSummaryText: event.currentTarget.value })}
        />
      </Field>
      <Field className="channel-proposal-edit-field" label={t("Open questions")}>
        <Textarea
          disabled={disabled}
          rows={3}
          value={draft.shapingOpenQuestionsText}
          onChange={(event) => onDraftChange({ shapingOpenQuestionsText: event.currentTarget.value })}
        />
      </Field>
      <Field className="channel-proposal-edit-field" label={t("User clarifications")}>
        <Textarea
          disabled={disabled}
          rows={3}
          value={draft.shapingClarificationsText}
          onChange={(event) => onDraftChange({ shapingClarificationsText: event.currentTarget.value })}
        />
      </Field>
      <div className="channel-proposal-edit-steps">
        <div className="channel-proposal-edit-steps-head">
          <strong>{t("Steps")}</strong>
          <button
            className="secondary-button compact-button"
            disabled={disabled}
            type="button"
            onClick={onAddStep}
          >
            <Plus size={14} />
            {t("Add step")}
          </button>
        </div>
        {draft.collaborationSteps.map((step, index) => (
          <div className="channel-proposal-edit-step" key={`${index}-${step.teammateId}-${step.action}`}>
            <Select
              aria-label={`${t("Assignee")} ${index + 1}`}
              disabled={disabled}
              size="sm"
              value={step.teammateId}
              onChange={(event) => onStepChange(index, { teammateId: event.currentTarget.value })}
            >
              {teammates.map((teammate) => (
                <option key={teammate.id} value={teammate.id}>{teammate.label}</option>
              ))}
              {teammates.some((teammate) => teammate.id === step.teammateId) ? null : (
                <option value={step.teammateId}>
                  {teammateLabel(step.teammateId, teammates, t("Deleted teammate"))}
                </option>
              )}
            </Select>
            <Select
              aria-label={`${t("Action")} ${index + 1}`}
              disabled={disabled}
              size="sm"
              value={step.action}
              onChange={(event) => onStepChange(index, {
                action: event.currentTarget.value as ChannelExecutionProposalEditorAction,
              })}
            >
              {proposalStepActions.map((action) => (
                <option key={action} value={action}>{t(proposalStepActionLabel(action))}</option>
              ))}
            </Select>
            <Field
              className="channel-proposal-edit-step-summary"
              label={<>{t("Summary")} {index + 1}</>}
            >
              <Textarea
                disabled={disabled}
                rows={2}
                size="sm"
                value={step.summary}
                onChange={(event) => onStepChange(index, { summary: event.currentTarget.value })}
              />
            </Field>
            <button
              className="secondary-button danger compact-button"
              disabled={disabled || !canRemoveStep}
              type="button"
              onClick={() => onRemoveStep(index)}
            >
              <Trash2 size={14} />
              {t("Remove")}
            </button>
          </div>
        ))}
      </div>
      {error ? (
        <div className="channel-proposal-error">
          <CircleAlert size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

function teammateLabel(
  teammateId: string | undefined,
  teammates: readonly ChannelExecutionProposalEditorTeammate[],
  fallback: string,
): string {
  if (!teammateId) {
    return fallback;
  }
  return teammates.find((teammate) => teammate.id === teammateId)?.label ?? fallback;
}

function proposalStepActionLabel(action: ChannelExecutionProposalEditorAction): string {
  switch (action) {
    case "consulted":
      return "Consulted";
    case "reviewed":
      return "Reviewed";
    case "flagged_risk":
      return "Flagged risk";
    default:
      return "Coordinated";
  }
}
