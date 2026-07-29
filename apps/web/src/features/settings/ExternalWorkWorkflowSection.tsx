import { FileCog, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  Field,
  InlineFeedback,
  Input,
  InspectorSection,
  Select,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { ExternalWorkStatusResponse } from "../../types.js";
import { ExternalWorkDetailList } from "./ExternalWorkDetailList.js";
import {
  externalWorkSourceLabel,
  externalWorkTarget,
  externalWorkWorkflowState,
  normalizeExternalWorkRepositoryInput,
} from "./external-work-settings-view-models.js";

export function ExternalWorkWorkflowSection({
  busy,
  errorMessage,
  onConfigure,
  status,
}: {
  readonly busy: boolean;
  readonly errorMessage?: string;
  readonly onConfigure: (input: {
    readonly sourceKind: "github" | "linear";
    readonly repository?: string;
    readonly projectSlug?: string;
  }) => Promise<boolean>;
  readonly status: ExternalWorkStatusResponse;
}): JSX.Element {
  const { t } = useI18n();
  const [sourceKind, setSourceKind] = useState<"github" | "linear">("github");
  const [repository, setRepository] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const presentation = externalWorkWorkflowState(status);
  const source = externalWorkSourceLabel(status);
  const target = externalWorkTarget(status);
  const normalizedRepository = normalizeExternalWorkRepositoryInput(repository);
  const repositoryInvalid = sourceKind === "github" && repository.trim().length > 0 && !normalizedRepository;
  const targetReady = sourceKind === "github"
    ? normalizedRepository !== undefined
    : projectSlug.trim().length > 0;
  const needsSetup = !status.workflow.valid || status.workflow.sourceKind === "unknown";

  useEffect(() => {
    if (status.workflow.sourceKind === "github" || status.workflow.sourceKind === "linear") {
      setSourceKind(status.workflow.sourceKind);
    }
    setRepository(status.workflow.repository ?? "");
    setProjectSlug(status.workflow.projectSlug ?? "");
  }, [status.workflow.projectSlug, status.workflow.repository, status.workflow.sourceKind]);

  return (
    <section className="settings-external-work-section" aria-labelledby="settings-external-work-workflow-title">
      <h2 id="settings-external-work-workflow-title">{t("Workflow")}</h2>
      <DataRow
        className="settings-external-work-row"
        identity={(
          <span className="settings-external-work-identity">
            <FileCog aria-hidden="true" />
            <span>
              <strong>WORKFLOW.md</strong>
              <small>{target ? `${t(source)} · ${target}` : t(source)}</small>
            </span>
          </span>
        )}
        status={<StatusIndicator compact label={t(presentation.label)} tone={presentation.tone} />}
      />

      {!status.workflow.valid ? (
        <InlineFeedback tone={status.workflow.exists ? "danger" : "warning"}>
          {t(status.workflow.exists
            ? "WORKFLOW.md needs attention. Repair it before polling."
            : "Create WORKFLOW.md before connecting an external source.")}
        </InlineFeedback>
      ) : null}
      {errorMessage ? (
        <InlineFeedback tone="danger">
          {t("WORKFLOW.md could not be saved. Review details and try again.")}
        </InlineFeedback>
      ) : null}

      {needsSetup ? (
        <div className="settings-external-work-form settings-external-work-workflow-form">
          <Field label={t("Source")}>
            <Select
              value={sourceKind}
              disabled={busy}
              onChange={(event) => setSourceKind(event.target.value === "linear" ? "linear" : "github")}
            >
              <option value="github">GitHub</option>
              <option value="linear">Linear</option>
            </Select>
          </Field>
          {sourceKind === "github" ? (
            <Field
              label={t("Repository")}
              error={repositoryInvalid ? t("Enter owner/repository or a valid GitHub URL.") : undefined}
            >
              <Input
                value={repository}
                disabled={busy}
                invalid={repositoryInvalid}
                placeholder={t("owner/repo or GitHub URL")}
                onChange={(event) => setRepository(event.target.value)}
              />
            </Field>
          ) : (
            <Field label={t("Project slug")}>
              <Input
                value={projectSlug}
                disabled={busy}
                placeholder={t("linear-project")}
                onChange={(event) => setProjectSlug(event.target.value)}
              />
            </Field>
          )}
          <Button
            className="settings-external-work-form-action"
            disabled={!targetReady}
            leadingIcon={<Save />}
            loading={busy}
            loadingLabel={t("Saving workflow")}
            onClick={() => void onConfigure({
              sourceKind,
              repository: sourceKind === "github" ? normalizedRepository : undefined,
              projectSlug: sourceKind === "linear" ? projectSlug.trim() : undefined,
            })}
          >
            {t(status.workflow.exists ? "Repair WORKFLOW.md" : "Create WORKFLOW.md")}
          </Button>
        </div>
      ) : null}

      <InspectorSection
        className="settings-external-work-details"
        title={t("Workflow details")}
        summary={target ?? t(source)}
      >
        <ExternalWorkDetailList
          items={[
            { label: t("Path"), value: status.workflow.path },
            { label: t("Source"), value: t(source) },
            { label: t("Events"), value: status.workflow.events.join(", ") || t("None") },
            ...(status.workflow.error ? [{ label: t("Validation issue"), value: status.workflow.error }] : []),
            ...(errorMessage ? [{ label: t("Last operation error"), value: errorMessage }] : []),
          ]}
        />
      </InspectorSection>
    </section>
  );
}
