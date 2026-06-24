import { useMemo } from "react";
import { useI18n } from "../../../i18n.js";
import { parseUnifiedDiff } from "../../../lib/diff-summary.js";
import { CodeBlock } from "./CodeBlock.js";
import { CopyActionButton } from "../feedback/CopyActionButton.js";
import { DiffViewer } from "./DiffViewer.js";

export interface DiffCodeBlockProps {
  readonly diff: string;
  readonly language?: string;
  readonly highlight?: boolean;
}

export function DiffCodeBlock({ diff, language, highlight = true }: DiffCodeBlockProps): JSX.Element {
  const { t } = useI18n();
  const changes = useMemo(() => parseUnifiedDiff(diff, {
    idPrefix: "message-diff",
    fallbackPath: "diff.patch",
    status: "completed",
  }), [diff]);
  const structuredChanges = changes.filter((change) => !change.malformed);

  if (!highlight || structuredChanges.length === 0) {
    return <CodeBlock code={diff} language={language ?? "diff"} highlight={false} copyLabel={t("Copy diff")} />;
  }

  const summaryLabel = structuredChanges.length === 1
    ? t("{count} file", { count: structuredChanges.length })
    : t("{count} files", { count: structuredChanges.length });

  return (
    <figure className="message-diff-block">
      <figcaption>
        <span>diff</span>
        <small>{summaryLabel}</small>
        <CopyActionButton text={diff} label={t("Copy diff")} className="message-code-copy" />
      </figcaption>
      <div className="message-diff-file-stack">
        {structuredChanges.map((change) => (
          <section key={change.id} className="message-diff-file" aria-label={change.path}>
            <div className="message-diff-file-head">
              <code>{change.path}</code>
              <span>
                +{change.additions ?? 0} / -{change.deletions ?? 0}
              </span>
            </div>
            <DiffViewer change={change} />
          </section>
        ))}
      </div>
    </figure>
  );
}

export function isDiffLanguage(language?: string): boolean {
  const normalized = language?.trim().toLowerCase();
  return normalized === "diff" || normalized === "patch";
}
