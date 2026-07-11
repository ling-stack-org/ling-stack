import type { ReactNode } from "react";
import { Globe2, Link2 } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { MessageWebEvidence } from "../../../types.js";
import { SourceIconStack, type SourceIconStackItem } from "../identity/SourceIconStack.js";
import {
  ConversationEvidenceBundlePanel,
  type ConversationEvidenceSection,
} from "./ConversationEvidenceBundlePanel.js";

interface MessageEvidencePanelProps {
  readonly memoryContent?: ReactNode;
  readonly memorySummary?: ReactNode;
  readonly webEvidence?: MessageWebEvidence;
  readonly defaultOpen?: boolean;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function MessageEvidencePanel({
  memoryContent,
  memorySummary,
  webEvidence,
  defaultOpen,
}: MessageEvidencePanelProps): JSX.Element | null {
  const { t } = useI18n();
  const renderableWebEvidence = projectConversationWebEvidence(webEvidence);
  const sections: ConversationEvidenceSection[] = [];
  if (memoryContent) {
    sections.push({
      id: "memory",
      label: t("Memory"),
      className: "conversation-evidence-section-flat",
      hideHeader: true,
      summary: typeof memorySummary === "string" ? memorySummary : t("Used memory"),
      content: memoryContent,
    });
  }
  sections.push(...buildWebEvidenceSections(renderableWebEvidence, t));
  if (sections.length === 0) {
    return null;
  }
  return (
    <ConversationEvidenceBundlePanel
      label={t("Message evidence")}
      bundle={{
        summary: messageEvidenceSummary(memoryContent ? memorySummary ?? t("Used memory") : undefined, renderableWebEvidence, t),
        sections,
      }}
      defaultOpen={defaultOpen ?? false}
    />
  );
}

function buildWebEvidenceSections(webEvidence: MessageWebEvidence | undefined, t: Translate): readonly ConversationEvidenceSection[] {
  if (!webEvidence) {
    return [];
  }
  const sections: ConversationEvidenceSection[] = [];
  if (webEvidence.sources.length > 0) {
    sections.push({
      id: "web-sources",
      label: t("Sources"),
      className: "conversation-evidence-section-compact-list",
      icon: <Link2 size={13} />,
      items: webEvidence.sources.map((source, index) => ({
        id: `source-${index}`,
        className: "conversation-evidence-source-item",
        label: source.title || sourceHost(source.url),
        value: (
          <a className="conversation-evidence-link" href={source.url} target="_blank" rel="noreferrer">
            {sourceHost(source.url)}
          </a>
        ),
        meta: source.snippet,
        icon: <Link2 size={12} />,
      })),
    });
  }

  if (webEvidence.readUrls.length > 0) {
    sections.push({
      id: "open-url",
      label: "open_url",
      summary: t("{count} URLs", { count: webEvidence.readUrls.length }),
      icon: <Globe2 size={13} />,
      items: webEvidence.readUrls.map((item, index) => ({
        id: `open-url-${index}`,
        label: item.title || sourceHost(item.finalUrl ?? item.url),
        value: (
          <a className="conversation-evidence-link" href={item.finalUrl ?? item.url} target="_blank" rel="noreferrer">
            {sourceHost(item.finalUrl ?? item.url)}
          </a>
        ),
        meta: item.reason,
        status: <span className={`conversation-evidence-status ${item.status}`}>{item.status}</span>,
        icon: <Globe2 size={12} />,
      })),
    });
  }

  return sections;
}

function projectConversationWebEvidence(webEvidence: MessageWebEvidence | undefined): MessageWebEvidence | undefined {
  if (!webEvidence) {
    return undefined;
  }
  const readUrls = webEvidence.readUrls.filter((item) => item.status === "available");
  if (webEvidence.sources.length === 0 && readUrls.length === 0) {
    return undefined;
  }
  return readUrls.length === webEvidence.readUrls.length
    ? webEvidence
    : { ...webEvidence, readUrls };
}

function messageEvidenceSummary(memorySummary: ReactNode | undefined, webEvidence: MessageWebEvidence | undefined, t: Translate): ReactNode {
  const parts: ReactNode[] = [];
  if (memorySummary) {
    parts.push(<span key="memory">{memorySummary}</span>);
  }
  const webSummary = webEvidence ? webEvidenceSummaryNode(webEvidence, t) : undefined;
  if (webSummary) {
    parts.push(webSummary);
  }
  if (parts.length === 0) {
    return "";
  }
  return (
    <span className="message-evidence-summary">
      {parts.map((part, index) => (
        <span key={index} className="message-evidence-summary-part">
          {index > 0 ? <span className="message-evidence-summary-separator" aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function webEvidenceSummaryNode(webEvidence: MessageWebEvidence, t: Translate): ReactNode {
  const fallback = webEvidenceSummaryText(webEvidence, t);
  if (webEvidence.sources.length > 0) {
    return <SourceIconStack sources={webSourceIconItems(webEvidence)} label={fallback} />;
  }
  return (
    <span className="message-evidence-web-status available" title={fallback} aria-label={fallback}>
      <Globe2 size={12} />
    </span>
  );
}

function webEvidenceSummaryText(webEvidence: MessageWebEvidence, t: Translate): string {
  const webParts: string[] = [];
  if (webEvidence.sources.length > 0) {
    webParts.push(`web_search ${t("{count} sources", { count: webEvidence.sources.length })}`);
  }
  if (webEvidence.readUrls.length > 0) {
    webParts.push(`open_url ${webEvidence.readUrls.length} URLs`);
  }
  return webParts.join(" / ") || "web evidence";
}

function webSourceIconItems(webEvidence: MessageWebEvidence): readonly SourceIconStackItem[] {
  return webEvidence.sources.map((source, index) => {
    const host = sourceHost(source.url);
    return {
      id: `web-source-${index}-${source.url}`,
      kind: "web",
      label: source.title || host,
      title: source.title ? `${source.title} · ${host}` : host,
      status: webEvidence.status,
    };
  });
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
