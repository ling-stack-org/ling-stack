import { Activity } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, Field, InlineFeedback, InspectorSection, Textarea } from "../../shared/ui/index.js";
import type { ThreadDetailController } from "./ThreadDetailPanel.js";

export function ThreadForkSection({ controller }: { readonly controller: ThreadDetailController }): React.JSX.Element {
  const { t } = useI18n();
  const { state, actions } = controller;
  return (
    <InspectorSection open summary={state.sourceRunId || "-"} title={t("Fork and run")}>
      <div className="runs-form-grid">
        <Field className="runs-form-wide" error={state.sourceRunId ? undefined : t("Select a source run before starting a child branch.")} label={t("Child instruction")}>
          <Textarea rows={3} value={state.forkRunInstruction} onChange={(event) => actions.setForkRunInstruction(event.target.value)} disabled={!state.canFork || state.busyActions.has("fork-run")} />
        </Field>
        {state.errors["fork-run"] ? <InlineFeedback className="runs-form-wide" tone="danger">{state.errors["fork-run"]}</InlineFeedback> : null}
        <div className="runs-form-actions runs-form-wide">
          <Button disabled={!state.canForkRun} leadingIcon={<Activity size={14} />} loading={state.busyActions.has("fork-run")} onClick={() => void actions.forkRun()} size="sm" variant="primary">{t("Start child branch")}</Button>
        </div>
        {state.forkRunRunId ? <p className="runs-readable-copy runs-form-wide"><strong>{t("Run started")}</strong>{state.forkRunRunId}</p> : null}
      </div>
    </InspectorSection>
  );
}
