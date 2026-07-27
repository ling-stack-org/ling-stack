import { useEffect, useRef } from "react";
import { Button, InlineFeedback, InspectorSection } from "../../shared/ui/index.js";
import type { SkillRevisionPreview } from "../../types.js";
import {
  approvalProfileSummary,
  authorityListDiffText,
  providerCapabilityLabel,
  toolLabel,
  warningLabel,
} from "./skill-editor-labels.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export function SkillEditorFeedback({
  error,
  conflict,
  preview,
  authorityConfirmation,
  busy,
  onReload,
  t,
}: {
  readonly error: string;
  readonly conflict: boolean;
  readonly preview: SkillRevisionPreview | undefined;
  readonly authorityConfirmation: boolean;
  readonly busy: boolean;
  readonly onReload: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const errorRef = useRef<HTMLDivElement>(null);
  const authorityRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = authorityConfirmation ? authorityRef.current : error ? errorRef.current : null;
    if (!target) return undefined;
    const frameId = globalThis.requestAnimationFrame(() => target.scrollIntoView({ block: "nearest" }));
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [authorityConfirmation, error]);

  return (
    <>
      {error ? (
        <InlineFeedback ref={errorRef} className="settings-skill-editor-error" tone="danger" title={error}>
          {conflict ? (
            <Button size="sm" variant="secondary" onClick={onReload} disabled={busy}>
              {t("Reload latest version")}
            </Button>
          ) : null}
        </InlineFeedback>
      ) : null}

      {preview?.warnings.length ? (
        <InspectorSection className="settings-skill-editor-review-notes" title={t("Things to review")}>
          <ul>
            {preview.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>{t(warningLabel(warning.code))}</li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}

      {authorityConfirmation && preview ? (
        <InlineFeedback
          ref={authorityRef}
          className="settings-skill-authority-confirmation"
          tone="warning"
          title={t("Runtime requirements changed")}
          aria-label={t("Runtime requirement changes")}
        >
          <p>{t("Review these changes before saving. Existing bindings stay unchanged.")}</p>
          <div className="settings-skill-authority-diff">
            {preview.authorityDiff.requiredToolsChanged ? (
              <span>
                <strong>{t("Required tools changed")}</strong>
                <small>{authorityListDiffText(
                  preview.authorityDiff.before.requiredTools,
                  preview.authorityDiff.after.requiredTools,
                  (value) => t(toolLabel(value)),
                  t,
                )}</small>
              </span>
            ) : null}
            {preview.authorityDiff.requiredProviderCapabilitiesChanged ? (
              <span>
                <strong>{t("Model capabilities changed")}</strong>
                <small>{authorityListDiffText(
                  preview.authorityDiff.before.requiredProviderCapabilities,
                  preview.authorityDiff.after.requiredProviderCapabilities,
                  (value) => t(providerCapabilityLabel(value)),
                  t,
                )}</small>
              </span>
            ) : null}
            {preview.authorityDiff.approvalProfileChanged ? (
              <span>
                <strong>{t("Approval policy changed")}</strong>
                <small>{t("From {before} to {after}", {
                  before: approvalProfileSummary(preview.authorityDiff.before.approvalProfile, t),
                  after: approvalProfileSummary(preview.authorityDiff.after.approvalProfile, t),
                })}</small>
              </span>
            ) : null}
          </div>
        </InlineFeedback>
      ) : null}
    </>
  );
}
