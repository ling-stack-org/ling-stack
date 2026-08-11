import { Check, CircleAlert } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Spinner, StatusIndicator, type StatusTone } from "../../shared/ui/index.js";
import type {
  TeammateCreateResult,
  TeammateCreateSetupStep,
  TeammateCreateStepState,
} from "./types.js";

export interface TeammateCreateStepViewState {
  readonly state: TeammateCreateStepState;
  readonly message: string;
}

export const teammateCreateSetupStepIds: readonly TeammateCreateSetupStep[] = [
  "workspace",
  "model",
  "record",
  "avatar",
  "channels",
  "memory",
  "refresh",
];

export function TeammateCreateProgress({
  result,
  steps,
}: {
  readonly result?: TeammateCreateResult;
  readonly steps: Readonly<Record<TeammateCreateSetupStep, TeammateCreateStepViewState>>;
}): React.JSX.Element {
  const { t } = useI18n();
  const state = result?.partial && result.teammateId
    ? "partial"
    : result?.ok
      ? "success"
      : result
        ? "failed"
        : "running";
  const status = progressStatus(state, t);
  const resultMessage = productizeSetupMessage(result?.message, t);

  return (
    <section className="teammate-create-progress" data-state={state} aria-label={t("Teammate setup progress")}>
      <div className="teammate-create-progress-summary">
        <span className="teammate-create-progress-symbol" data-state={state} aria-hidden="true">
          {state === "running" ? <Spinner size="md" /> : state === "success" ? <Check /> : <CircleAlert />}
        </span>
        <span className="teammate-create-progress-copy">
          <StatusIndicator label={status.label} tone={status.tone} />
          <p>{resultMessage ?? t("Keep this dialog open while Ling prepares the teammate.")}</p>
        </span>
      </div>

      <ol className="teammate-create-step-list">
        {teammateCreateSetupStepIds.map((step) => (
          <li key={step} className={`teammate-create-step ${steps[step].state}`} data-state={steps[step].state}>
            <span className="teammate-create-step-icon" aria-hidden="true">{renderStepIcon(steps[step].state)}</span>
            <span className="teammate-create-step-copy">
              <strong>{t(setupStepLabel(step))}</strong>
              <small>{productizeSetupMessage(steps[step].message, t) || t(setupStepDefaultMessage(step))}</small>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function progressStatus(
  state: "failed" | "partial" | "running" | "success",
  t: (key: string) => string,
): { readonly label: string; readonly tone: StatusTone } {
  if (state === "success") return { label: t("Teammate ready"), tone: "success" };
  if (state === "partial") return { label: t("Teammate created with setup warnings"), tone: "warning" };
  if (state === "failed") return { label: t("Setup needs attention"), tone: "danger" };
  return { label: t("Creating and checking teammate"), tone: "info" };
}

function productizeSetupMessage(message: string | undefined, t: (key: string) => string): string | undefined {
  if (!message) return undefined;
  if (message.toLocaleLowerCase().includes("provider rejected the endpoint or model")) {
    return t("Provider rejected the endpoint or model. Check it in Model Workbench, then try again.");
  }
  return message;
}

function renderStepIcon(state: TeammateCreateStepState): React.JSX.Element {
  if (state === "running") return <Spinner size="sm" />;
  if (state === "failed") return <CircleAlert />;
  if (state === "success" || state === "skipped") return <Check />;
  return <span />;
}

function setupStepLabel(step: TeammateCreateSetupStep): string {
  switch (step) {
    case "workspace": return "Workspace";
    case "model": return "Model check";
    case "record": return "Create teammate";
    case "avatar": return "Upload avatar";
    case "channels": return "Join channel";
    case "memory": return "Prepare memory";
    case "refresh": return "Refresh workspace";
  }
}

function setupStepDefaultMessage(step: TeammateCreateSetupStep): string {
  switch (step) {
    case "workspace": return "Waiting for workspace";
    case "model": return "Waiting to check the selected model";
    case "record": return "Waiting to create the teammate";
    case "avatar": return "Waiting for avatar upload";
    case "channels": return "Waiting for channel setup";
    case "memory": return "Waiting for memory setup";
    case "refresh": return "Waiting to refresh workspace";
  }
}
