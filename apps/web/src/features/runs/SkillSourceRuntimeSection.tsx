import { BookOpen } from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import { formatEventPreview, readDataBoolean, readDataField, readDataNumber, readDataString } from "../../lib/data.js";
import { MetaRow } from "../../shared/components/index.js";
import { InspectorSection, StatusIndicator } from "../../shared/ui/index.js";

export function SkillSourceRuntimeSection({ context }: { readonly context: unknown }): React.JSX.Element {
  const { t } = useI18n();
  const loaded = readDataBoolean(context, "loaded");
  const truncated = readDataBoolean(context, "truncated");
  const runtimeViewKind = readDataString(context, "runtimeViewKind") || "original_source";
  const includedRefs = readArray(context, "includedRefs");
  const deferredRefs = readArray(context, "deferredRefs");
  const materializedRefs = readArray(context, "materializedRefs");
  const referencedFiles = readArray(context, "referencedFiles");
  return (
    <InspectorSection
      open
      summary={<StatusIndicator compact label={loaded ? truncated ? t("Truncated") : t("Loaded") : t("Suppressed")} tone={loaded ? truncated ? "warning" : "success" : "danger"} />}
      title={t("Skill source context")}
    >
      <h3 className="runs-section-heading"><BookOpen size={15} />{t("Skill source context")}</h3>
      <div className="runs-summary-grid">
        <MetaRow label={t("Skill")} value={readDataString(context, "skillId") || "-"} compact />
        <MetaRow label={t("Runtime view")} value={runtimeViewLabel(runtimeViewKind, t)} compact />
        <MetaRow label={t("Optimization mode")} value={readDataString(context, "optimizationMode") || "-"} compact />
        <MetaRow label={t("Snapshot")} value={readDataString(context, "snapshotId") || "-"} compact />
        <MetaRow label={t("Checksum")} value={readDataString(context, "sourceChecksum") || "-"} compact />
        <MetaRow label={t("Source kind")} value={readDataString(context, "sourceKind") || "-"} compact />
        <MetaRow label={t("Upstream")} value={[readDataString(context, "upstreamName"), readDataString(context, "upstreamVersion")].filter(Boolean).join(" ") || "-"} compact />
        <MetaRow label={t("Path")} value={readDataString(context, "upstreamSkillPath") || readDataString(context, "sourcePath") || "-"} compact />
        <MetaRow label={t("Loaded chars")} value={`${readDataNumber(context, "loadedChars") ?? 0}/${readDataNumber(context, "sourceLengthChars") ?? readDataNumber(context, "maxLoadedChars") ?? 0}`} compact />
        <MetaRow label={t("Token estimate")} value={String(readDataNumber(context, "tokenEstimate") ?? "-")} compact />
      </div>
      <div className="runs-skill-source-refs" aria-label={t("Skill context references")}>
        {includedRefs.map((ref, index) => <code key={`included:${readDataString(ref, "id") || index}`}>{t("Included")}: {formatRuntimeReference(ref)}</code>)}
        {deferredRefs.map((ref, index) => <code key={`deferred:${readDataString(ref, "id") || index}`}>{t("Deferred")}: {formatRuntimeReference(ref)}</code>)}
        {materializedRefs.map((ref, index) => <code key={`materialized:${readDataString(ref, "id") || index}`}>{t("Materialized")}: {formatRuntimeReference(ref)}</code>)}
        {referencedFiles.map((file, index) => <code key={`file:${readDataString(file, "path") || index}`}>{readDataString(file, "path") || formatEventPreview(file)}</code>)}
      </div>
    </InspectorSection>
  );
}

export function skillSourceRuntimeSummary(context: unknown, t: Translate): string {
  if (!context) return "-";
  const runtimeViewKind = readDataString(context, "runtimeViewKind");
  if (runtimeViewKind) return runtimeViewLabel(runtimeViewKind, t);
  if (!readDataBoolean(context, "loaded")) return readDataString(context, "snapshotId") ? t("Suppressed") : "-";
  return readDataBoolean(context, "truncated") ? t("Loaded, truncated") : t("Loaded");
}

function runtimeViewLabel(kind: string, t: Translate): string {
  const labels: Readonly<Record<string, string>> = { metadata_only: "Metadata only", original_source: "Original source", compiled_view: "Compiled view", disabled_for_runner: "Disabled for runner", fallback_original: "Fallback original" };
  return t(labels[kind] ?? kind);
}

function formatRuntimeReference(ref: unknown): string {
  return [readDataString(ref, "title"), readDataString(ref, "kind"), readDataString(ref, "sourceRef")].filter(Boolean).join(" / ") || formatEventPreview(ref);
}

function readArray(data: unknown, key: string): readonly unknown[] {
  const value = readDataField(data, key);
  return Array.isArray(value) ? value : [];
}
