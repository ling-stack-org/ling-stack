import { Copy, Download, ExternalLink, RotateCcw } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { artifactDownloadName } from "../../lib/artifacts.js";
import { Button, InlineFeedback, InspectorSection } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { MediaJobActionId, MediaJobProjectionInput } from "./media-job-types.js";
import { sanitizeMediaJobDetails } from "./media-job-result-view-models.js";
import { MediaArtifactPreview } from "./MediaArtifactPreview.js";
import { MediaJobArtifactRow } from "./MediaJobArtifactRow.js";

export function MediaJobResult({
  cwd,
  projection,
  copyError,
  onAction,
  onRetryArtifacts,
}: {
  readonly cwd: string;
  readonly projection: MediaJobProjectionInput;
  readonly copyError: string;
  readonly onAction: (action: MediaJobActionId, projection: MediaJobProjectionInput) => void;
  readonly onRetryArtifacts: (jobId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const { job, result } = projection;
  const primaryHref = result.primary ? artifactContentUrl(result.primary.id, cwd) : "";
  const parameters = visibleParameters(job.input);
  return (
    <div className="media-job-result" data-media-job-result={result.state}>
      {result.primary ? <MediaArtifactPreview artifact={result.primary} cwd={cwd} mode="hero" /> : (
        <div className="media-job-result-fallback" aria-busy={result.state === "loading" || undefined}>
          <strong>{t(resultTitle(result.state))}</strong>
          {result.state === "unavailable" || result.state === "missing" ? (
            <Button leadingIcon={<RotateCcw size={15} />} size="sm" onClick={() => onRetryArtifacts(job.id)}>{t("Retry")}</Button>
          ) : null}
        </div>
      )}
      <div className="media-job-result-actions" aria-label={t("Result actions")}>
        {result.primary ? (
          <>
            <Button asChild leadingIcon={<ExternalLink size={15} />} variant="primary"><a href={primaryHref} target="_blank" rel="noreferrer">{t("View result")}</a></Button>
            <Button asChild leadingIcon={<Download size={15} />}><a href={primaryHref} download={artifactDownloadName(result.primary)}>{t("Download")}</a></Button>
            <Button leadingIcon={<Copy size={15} />} onClick={() => onAction("copy_result_link", projection)}>{t("Copy result URL")}</Button>
          </>
        ) : null}
        <Button leadingIcon={<Copy size={15} />} onClick={() => onAction("copy_prompt", projection)}>{t("Copy prompt")}</Button>
        <Button onClick={() => onAction("reuse_settings", projection)}>{t("Reuse settings")}</Button>
      </div>
      {copyError ? <InlineFeedback tone="danger" role="alert">{copyError}</InlineFeedback> : null}
      {parameters.length ? (
        <dl className="media-job-parameter-list">
          {parameters.map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : null}
      <InspectorSection title={t("Prompt")} summary={t("Full prompt")}>
        <p className="media-job-full-prompt">{job.prompt}</p>
      </InspectorSection>
      {result.mediaArtifacts.length > 0 ? (
        <InspectorSection title={t("All results")} summary={String(result.mediaArtifacts.length)}>
          <div className="media-job-artifact-list">
            {result.mediaArtifacts.map((artifact) => <MediaJobArtifactRow key={artifact.id} artifact={artifact} cwd={cwd} />)}
          </div>
        </InspectorSection>
      ) : null}
      <InspectorSection title={t("Technical details")} summary={t("IDs, status, and supporting artifacts")}>
        <dl className="media-job-technical-list">
          <div><dt>{t("Task ID")}</dt><dd>{job.id}</dd></div>
          <div><dt>{t("Status")}</dt><dd>{job.status}</dd></div>
          <div><dt>{t("Created")}</dt><dd>{job.createdAt}</dd></div>
          <div><dt>{t("Updated")}</dt><dd>{job.updatedAt}</dd></div>
        </dl>
        <pre>{JSON.stringify(sanitizeMediaJobDetails(job.input), null, 2)}</pre>
        {result.auxiliaryArtifacts.length ? <p>{result.auxiliaryArtifacts.map((item) => item.title || item.type).join(" · ")}</p> : null}
      </InspectorSection>
    </div>
  );
}

function visibleParameters(input: Record<string, unknown>): readonly [string, string][] {
  const keys = ["size", "n", "count", "seed", "watermark", "ratio", "aspect_ratio", "duration", "duration_seconds"];
  return keys.flatMap((key) => {
    const value = input[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [[key, String(value)] as [string, string]] : [];
  });
}

function resultTitle(state: MediaJobProjectionInput["result"]["state"]): string {
  if (state === "loading") return "Loading result";
  if (state === "unavailable") return "Result unavailable";
  if (state === "missing") return "No usable result was returned";
  return "No result yet";
}
