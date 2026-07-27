import { Cpu, Settings2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
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
}): JSX.Element {
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
            value={viewModel.selectedProviderId}
            onChange={(event) => onSelectProvider(event.target.value)}
          >
            <option value="">{t("None")}</option>
            {viewModel.options.map((option) => (
              <option key={option.id} disabled={option.disabled} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {!viewModel.emptyInventory ? (
        <div className="teammate-model-summary" aria-label={t("Model summary")}>
          <ModelSummaryRow label={t("Model ID")} value={viewModel.modelLabel} />
          <ModelSummaryRow label={t("Model provider")} value={viewModel.providerLabel} />
        </div>
      ) : null}

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

function ModelSummaryRow({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <DataRow
      compact
      className="teammate-model-summary-row"
      identity={<span className="teammate-model-summary-label">{label}</span>}
      status={<span className="teammate-model-summary-value" title={value}>{value}</span>}
    />
  );
}
