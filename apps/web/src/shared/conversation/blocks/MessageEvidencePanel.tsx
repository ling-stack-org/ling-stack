import type { ReactNode } from "react";
import { Globe2, Link2, Search, ShieldAlert } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { MessageWebEvidence } from "../../../types.js";
import {
  ConversationEvidenceBundlePanel,
  type ConversationEvidenceItem,
  type ConversationEvidenceSection,
} from "./ConversationEvidenceBundlePanel.js";

interface MessageEvidencePanelProps {
  readonly memoryContent?: ReactNode;
  readonly memorySummary?: string;
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
  const sections: ConversationEvidenceSection[] = [];
  if (memoryContent) {
    sections.push({
      id: "memory",
      label: t("Memory"),
      summary: memorySummary ?? t("Used memory"),
      content: memoryContent,
    });
  }
  sections.push(...buildWebEvidenceSections(webEvidence, t));
  if (sections.length === 0) {
    return null;
  }
  const resolvedDefaultOpen = defaultOpen ?? shouldOpenMessageEvidenceByDefault(webEvidence);
  return (
    <ConversationEvidenceBundlePanel
      label={t("Message evidence")}
      bundle={{
        summary: messageEvidenceSummary(Boolean(memoryContent), webEvidence, t),
        sections,
      }}
      defaultOpen={resolvedDefaultOpen}
    />
  );
}

function buildWebEvidenceSections(webEvidence: MessageWebEvidence | undefined, t: Translate): readonly ConversationEvidenceSection[] {
  if (!webEvidence) {
    return [];
  }
  const sections: ConversationEvidenceSection[] = [];
  const searchItems: ConversationEvidenceItem[] = [
    {
      id: "status",
      label: t("Status"),
      value: <span className={`conversation-evidence-status ${webEvidence.status}`}>{t(webEvidence.status)}</span>,
      icon: webEvidence.status === "available" ? <Globe2 size={12} /> : <ShieldAlert size={12} />,
    },
  ];
  if (webEvidence.query) {
    searchItems.push({
      id: "query",
      label: "web_search",
      value: <code className="conversation-evidence-code">{webEvidence.query}</code>,
      icon: <Search size={12} />,
    });
  }
  if (webEvidence.queries && webEvidence.queries.length > 0) {
    searchItems.push({
      id: "queries",
      label: t("Search queries"),
      value: (
        <span className="conversation-evidence-code-list">
          {webEvidence.queries.map((query, index) => (
            <code key={`${index}-${query}`} className="conversation-evidence-code">{query}</code>
          ))}
        </span>
      ),
      icon: <Search size={12} />,
    });
  }
  if (webEvidence.provider) {
    searchItems.push({
      id: "provider",
      label: t("Provider"),
      value: webEvidence.provider.displayName,
      meta: webEvidence.provider.adapterId,
    });
  }
  if (webEvidence.reason) {
    searchItems.push({
      id: "blocked-reason",
      label: webEvidence.status === "blocked" ? t("Blocked reason") : t("Degraded reason"),
      className: "conversation-evidence-item-wide",
      value: <span className="conversation-evidence-reason">{webEvidence.reason}</span>,
      icon: <ShieldAlert size={12} />,
    });
  }
  searchItems.push({
    id: "source-count",
    label: t("Sources"),
    value: t("{count} sources", { count: webEvidence.sources.length }),
    icon: <Link2 size={12} />,
  });
  sections.push({
    id: "web-search",
    label: "web_search",
    summary: webEvidenceSearchSummary(webEvidence, t),
    icon: webEvidence.status === "available" ? <Search size={13} /> : <ShieldAlert size={13} />,
    items: searchItems,
  });

  if (webEvidence.sources.length > 0) {
    sections.push({
      id: "web-sources",
      label: t("Sources"),
      summary: t("{count} sources", { count: webEvidence.sources.length }),
      icon: <Link2 size={13} />,
      items: webEvidence.sources.map((source, index) => ({
        id: `source-${index}`,
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
        icon: item.status === "blocked" ? <ShieldAlert size={12} /> : <Globe2 size={12} />,
      })),
    });
  }

  return sections;
}

function messageEvidenceSummary(hasMemory: boolean, webEvidence: MessageWebEvidence | undefined, t: Translate): ReactNode {
  const parts: ReactNode[] = [];
  if (hasMemory) {
    parts.push(<span key="memory">{t("Used memory")}</span>);
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
  if (webEvidence.status === "available" && webEvidence.sources.length > 0) {
    return <WebSourceIconStack sources={webEvidence.sources} label={fallback} />;
  }
  return <WebEvidenceStatusIcon webEvidence={webEvidence} label={fallback} />;
}

function webEvidenceSummaryText(webEvidence: MessageWebEvidence, t: Translate): string {
  const webParts: string[] = [];
  if (webEvidence.query || webEvidence.reason || webEvidence.sources.length > 0 || webEvidence.queries?.length) {
    if (webEvidence.status === "blocked") {
      webParts.push(webEvidence.reason ? `web_search blocked: ${shortReason(webEvidence.reason)}` : "web_search blocked");
    } else if (webEvidence.status === "degraded") {
      webParts.push(webEvidence.reason ? `web_search degraded: ${shortReason(webEvidence.reason)}` : "web_search degraded");
    } else {
      webParts.push(`web_search ${t("{count} sources", { count: webEvidence.sources.length })}`);
    }
  }
  if (webEvidence.readUrls.length > 0) {
    webParts.push(`open_url ${webEvidence.readUrls.length} URLs`);
  }
  return webParts.join(" / ") || "web evidence";
}

function webEvidenceSearchSummary(webEvidence: MessageWebEvidence, t: Translate): string {
  if (webEvidence.status === "blocked") {
    return t("blocked");
  }
  if (webEvidence.status === "degraded") {
    return t("degraded");
  }
  return t("{count} sources", { count: webEvidence.sources.length });
}

function shouldOpenMessageEvidenceByDefault(webEvidence: MessageWebEvidence | undefined): boolean {
  return webEvidence?.status === "blocked" || webEvidence?.status === "degraded";
}

function WebSourceIconStack({
  sources,
  label,
}: {
  readonly sources: MessageWebEvidence["sources"];
  readonly label: string;
}): JSX.Element {
  const visibleSources = sources.slice(0, 4);
  const overflowCount = sources.length - visibleSources.length;
  return (
    <span className="message-evidence-source-stack" title={label} aria-label={label}>
      {visibleSources.map((source, index) => {
        const host = sourceHost(source.url);
        return (
          <span
            key={`${index}-${source.url}`}
            className={`message-evidence-source-icon tone-${index % 5}`}
            title={source.title ? `${source.title} · ${host}` : host}
            aria-hidden="true"
          >
            <Globe2 size={15} strokeWidth={1.9} />
          </span>
        );
      })}
      {overflowCount > 0 ? (
        <span className="message-evidence-source-overflow" aria-hidden="true">
          +{overflowCount}
        </span>
      ) : null}
    </span>
  );
}

function WebEvidenceStatusIcon({
  webEvidence,
  label,
}: {
  readonly webEvidence: MessageWebEvidence;
  readonly label: string;
}): JSX.Element {
  return (
    <span className={`message-evidence-web-status ${webEvidence.status}`} title={label} aria-label={label}>
      {webEvidence.status === "available" ? <Search size={12} /> : <ShieldAlert size={12} />}
    </span>
  );
}

function shortReason(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
