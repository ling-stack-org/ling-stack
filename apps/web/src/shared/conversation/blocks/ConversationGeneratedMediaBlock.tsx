import { Download, ExternalLink, Image as ImageIcon, Video } from "lucide-react";
import { artifactContentUrl } from "../../../api/media.js";
import { useI18n } from "../../../i18n.js";
import { artifactDownloadName } from "../../../lib/artifacts.js";
import type { ConversationGeneratedMedia, RunArtifact } from "../../../types.js";
import { displayableGeneratedMediaArtifacts } from "../generated-media.js";
import { Spinner } from "../../ui/index.js";

export interface ConversationGeneratedMediaBlockProps {
  readonly items: readonly ConversationGeneratedMedia[];
  readonly cwd: string;
}

export function ConversationGeneratedMediaBlock({
  items,
  cwd,
}: ConversationGeneratedMediaBlockProps): React.JSX.Element | null {
  const { t } = useI18n();
  if (items.length === 0) return null;

  return (
    <div className="conversation-generated-media-list" aria-label={t("Generated media")}>
      {items.map((item) => {
        const video = item.operation === "video_generate";
        const pending = item.status === "queued" || item.status === "running" || item.status === "waiting_for_approval";
        const mediaArtifacts = displayableGeneratedMediaArtifacts(item);
        return (
          <section
            className={`conversation-generated-media status-${item.status}`}
            data-media-job-id={item.mediaJobId}
            data-media-job-status={item.status}
            key={item.mediaJobId}
          >
            {item.status !== "succeeded" ? (
              <header className="conversation-generated-media-header">
                <span className="conversation-generated-media-kind" aria-hidden="true">
                  {video ? <Video size={16} /> : <ImageIcon size={16} />}
                </span>
                <span className="conversation-generated-media-heading">
                  <strong>{mediaStatusLabel(item, t)}</strong>
                  {pending ? <small>{t("Using {target}", { target: item.target.displayName })}</small> : null}
                </span>
                {pending ? <Spinner className="conversation-generated-media-spinner" size="sm" /> : null}
              </header>
            ) : null}
            {item.status === "succeeded" ? (
              mediaArtifacts.length > 0 ? (
                <div className="conversation-generated-media-artifacts">
                  {mediaArtifacts.map((artifact) => (
                    <GeneratedMediaArtifact artifact={artifact} cwd={cwd} key={artifact.id} />
                  ))}
                </div>
              ) : (
                <p className="conversation-generated-media-message">{t("The generation finished without a usable preview.")}</p>
              )
            ) : null}
            {item.status === "failed" ? (
              <p className="conversation-generated-media-message" role="alert">
                {mediaFailureMessage(item, t)}
              </p>
            ) : null}
            {item.status === "cancelled" ? (
              <p className="conversation-generated-media-message">{t("Media generation was cancelled.")}</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function mediaFailureMessage(
  item: Pick<ConversationGeneratedMedia, "failureCode" | "operation">,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const failureCode = item.failureCode;
  if (failureCode === "generation_target_unavailable") {
    return t("The generation target is unavailable. Check the default use in Model Workbench.");
  }
  if (failureCode === "generation_configuration_required") {
    return t("The generation target needs configuration. Open Media Tasks for details.");
  }
  if (failureCode === "generation_content_policy_blocked") {
    return t("The generation service rejected this request under its content policy. Adjust the description and try again.");
  }
  if (failureCode === "generation_authorization_required") {
    return t("The generation target needs valid credentials. Check it in Model Workbench.");
  }
  if (failureCode === "generation_timed_out") {
    return t("Media generation timed out. Try again from Media Tasks.");
  }
  if (failureCode === "generation_result_unavailable") {
    return item.operation === "video_generate"
      ? t("The upstream generation service responded but did not return video data. Try again; if this continues, check Media Tasks.")
      : t("The upstream generation service responded but did not return image data. Try again; if this continues, check Media Tasks.");
  }
  return t("Media generation failed. Open Media Tasks for details.");
}

function GeneratedMediaArtifact({ artifact, cwd }: {
  readonly artifact: RunArtifact;
  readonly cwd: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const url = artifactContentUrl(artifact.id, cwd);
  const title = artifact.title || artifactDownloadName(artifact);
  return (
    <figure className={`conversation-generated-media-artifact artifact-${artifact.type}`}>
      {artifact.type === "video" ? (
        <video controls preload="metadata" playsInline aria-label={title}>
          <source src={url} type={artifact.contentType ?? "video/mp4"} />
          {t("This browser cannot play this video.")}
        </video>
      ) : (
        <img src={url} alt={title} loading="lazy" />
      )}
      <figcaption aria-label={t("Generated result actions")}>
        <span className="conversation-generated-media-actions">
          <a href={url} target="_blank" rel="noreferrer" aria-label={t("Open generated result")} title={t("Open generated result")}>
            <ExternalLink size={15} />
          </a>
          <a href={url} download={artifactDownloadName(artifact)} aria-label={t("Download generated result")} title={t("Download generated result")}>
            <Download size={15} />
          </a>
        </span>
      </figcaption>
    </figure>
  );
}

function mediaStatusLabel(
  item: ConversationGeneratedMedia,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const noun = item.operation === "video_generate" ? t("Video") : t("Image");
  if (item.status === "queued") return t("{kind} generation queued", { kind: noun });
  if (item.status === "running") return t("Generating {kind}", { kind: noun });
  if (item.status === "waiting_for_approval") return t("{kind} generation needs confirmation", { kind: noun });
  if (item.status === "succeeded") return t("{kind} generated", { kind: noun });
  if (item.status === "cancelled") return t("{kind} generation cancelled", { kind: noun });
  return t("{kind} generation failed", { kind: noun });
}
