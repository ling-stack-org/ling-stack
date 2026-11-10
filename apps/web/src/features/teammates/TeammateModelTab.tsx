import { Cpu, Settings2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  EmptyState,
  Field,
  InlineFeedback,
  Select,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { TeammateModelViewModel } from "./teammate-model-view-models.js";

export function TeammateModelTab({
  modelError,
  savingModel,
  viewModel,
  onOpenProviders,
  onSelectProvider,
}: {
  readonly modelError: string;
  readonly savingModel: boolean;
  readonly viewModel: TeammateModelViewModel;
  readonly onOpenProviders: () => void;
  readonly onSelectProvider: (providerPresetId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const workbenchAction = (
    <Button leadingIcon={<Settings2 />} size="sm" variant="secondary" onClick={onOpenProviders}>
      {t("Open Model Workbench")}
    </Button>
  );

  return (
    <section className="teammate-model-panel" aria-label={t("Model assignment")}>
      <header className="teammate-model-heading">
        <div>
          <Cpu size={17} aria-hidden="true" />
          <h2>{t("Model assignment")}</h2>
        </div>
        <StatusIndicator className="teammate-model-state" label={viewModel.primaryLabel} tone={viewModel.primaryTone} />
      </header>

      {modelError ? (
        <InlineFeedback className="teammate-model-error" tone="danger">
          {modelError}
        </InlineFeedback>
      ) : null}

      {viewModel.emptyInventory ? (
        <EmptyState
          compact
          action={workbenchAction}
          className="teammate-model-empty"
          icon={<Cpu />}
          title={t("No models configured")}
          description={t("Configure a chat model in Model Workbench before assigning one.")}
        />
      ) : viewModel.isProtected ? null : (
        <Field className="teammate-model-field" label={t("Assigned model")}>
          <Select
            disabled={savingModel}
            value={viewModel.selectionValue}
            onChange={(event) => onSelectProvider(event.target.value)}
          >
            {!viewModel.selectionValue ? <option disabled value="">{t("Choose a model")}</option> : null}
            {viewModel.options.map((option) => (
              <option key={option.id} disabled={option.disabled} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {viewModel.feedback ? (
        <InlineFeedback className="teammate-model-feedback" tone={viewModel.feedback.tone}>
          {viewModel.feedback.detail}
        </InlineFeedback>
      ) : null}

      {!viewModel.emptyInventory ? (
        <div className="teammate-model-actions">{workbenchAction}</div>
      ) : null}
    </section>
  );
}
