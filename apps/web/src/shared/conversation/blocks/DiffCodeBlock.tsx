import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n.js";
import { parseUnifiedDiff } from "../../../lib/diff-summary.js";
import { CodeBlock } from "./CodeBlock.js";
import { CopyActionButton } from "../feedback/CopyActionButton.js";
import { DiffViewer } from "./DiffViewer.js";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

export interface DiffCodeBlockProps {
  readonly diff: string;
  readonly language?: string;
  readonly highlight?: boolean;
}

const largeDiffFileThreshold = 6;
const largeDiffLineThreshold = 180;
const largeDiffCharacterThreshold = 24_000;

export function DiffCodeBlock({ diff, language, highlight = true }: DiffCodeBlockProps): JSX.Element {
  const { t } = useI18n();
  const rootRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const diffSummary = useMemo(() => scanUnifiedDiffSummary(diff), [diff]);
  const shouldDeferBody = diffSummary.fileCount > largeDiffFileThreshold ||
    diffSummary.lineCount > largeDiffLineThreshold ||
    diffSummary.characters > largeDiffCharacterThreshold;
  const bodyMounted = !shouldDeferBody || expanded;
  const changes = useMemo(() => bodyMounted ? parseUnifiedDiff(diff, {
    idPrefix: "message-diff",
    fallbackPath: "diff.patch",
    status: "completed",
  }) : [], [bodyMounted, diff]);
  const structuredChanges = bodyMounted ? changes.filter((change) => !change.malformed) : [];

  useEffect(() => {
    if (!bodyMounted) {
      return;
    }
    const frameId = globalThis.requestAnimationFrame(() => {
      notifyConversationDeferredContentReady(rootRef.current);
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [bodyMounted, structuredChanges.length]);

  if (shouldDeferBody && !expanded) {
    const summaryLabel = diffSummary.fileCount === 1
      ? t("{count} file", { count: diffSummary.fileCount })
      : t("{count} files", { count: diffSummary.fileCount });
    return (
      <figure ref={rootRef} className="message-diff-block deferred">
        <figcaption>
          <span>diff</span>
          <small>{summaryLabel} · {t("{count} lines", { count: diffSummary.lineCount })}</small>
          <CopyActionButton text={diff} label={t("Copy diff")} className="message-code-copy" />
        </figcaption>
        <div className="message-deferred-body-shell">
          <strong>{t("Large diff deferred")}</strong>
          <span>
            +{diffSummary.additions} / -{diffSummary.deletions} · {formatDiffSize(diffSummary.characters)}
          </span>
          <button
            className="message-code-expand"
            type="button"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            {t("Show diff details")}
          </button>
        </div>
      </figure>
    );
  }

  if (!highlight || structuredChanges.length === 0) {
    return <CodeBlock code={diff} language={language ?? "diff"} highlight={false} copyLabel={t("Copy diff")} />;
  }

  const summaryLabel = structuredChanges.length === 1
    ? t("{count} file", { count: structuredChanges.length })
    : t("{count} files", { count: structuredChanges.length });

  return (
    <figure ref={rootRef} className={["message-diff-block", shouldDeferBody ? "expanded-deferred" : ""].filter(Boolean).join(" ")}>
      <figcaption>
        <span>diff</span>
        <small>{summaryLabel} · +{diffSummary.additions} / -{diffSummary.deletions}</small>
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
      {shouldDeferBody ? (
        <button
          className="message-code-expand"
          type="button"
          aria-expanded={true}
          onClick={() => setExpanded(false)}
        >
          {t("Collapse diff details")}
        </button>
      ) : null}
    </figure>
  );
}

interface UnifiedDiffSummary {
  readonly additions: number;
  readonly characters: number;
  readonly deletions: number;
  readonly fileCount: number;
  readonly lineCount: number;
}

function scanUnifiedDiffSummary(diff: string): UnifiedDiffSummary {
  let additions = 0;
  let deletions = 0;
  let fileCount = 0;
  let lineCount = diff.length > 0 ? 1 : 0;
  let hasExplicitFile = false;
  let lineStart = 0;
  for (let index = 0; index <= diff.length; index += 1) {
    const atEnd = index === diff.length;
    if (!atEnd && diff.charCodeAt(index) !== 10) {
      continue;
    }
    const line = diff.slice(lineStart, atEnd ? index : index);
    if (!atEnd) {
      lineCount += 1;
    }
    if (line.startsWith("diff --git ")) {
      fileCount += 1;
      hasExplicitFile = true;
    } else if (!hasExplicitFile && (line.startsWith("+++ ") || line.startsWith("--- "))) {
      fileCount = 1;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
    lineStart = index + 1;
  }
  return {
    additions,
    characters: diff.length,
    deletions,
    fileCount: Math.max(1, fileCount),
    lineCount,
  };
}

function formatDiffSize(characters: number): string {
  if (characters < 1024) {
    return `${characters} B`;
  }
  if (characters < 1024 * 1024) {
    return `${(characters / 1024).toFixed(1)} KB`;
  }
  return `${(characters / (1024 * 1024)).toFixed(1)} MB`;
}

export function isDiffLanguage(language?: string): boolean {
  const normalized = language?.trim().toLowerCase();
  return normalized === "diff" || normalized === "patch";
}
