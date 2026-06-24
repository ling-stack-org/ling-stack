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
  return (
    <ConversationEvidenceBundlePanel
      label={t("Message evidence")}
      bundle={{
        summary: summarizeMessageEvidence(Boolean(memoryContent), webEvidence, t),
        sections,
      }}
      defaultOpen={defaultOpen}
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
      value: <span className={`conversation-evidence-status ${webEvidence.status}`}>{webEvidence.status}</span>,
      icon: webEvidence.status === "blocked" ? <ShieldAlert size={12} /> : <Globe2 size={12} />,
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
      label: t("Blocked reason"),
      value: webEvidence.reason,
      icon: <ShieldAlert size={12} />,
    });
  }
  sections.push({
    id: "web-search",
    label: "web_search",
    summary: webEvidence.status === "blocked"
      ? t("blocked")
      : t("{count} sources", { count: webEvidence.sources.length }),
    icon: <Search size={13} />,
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

function summarizeMessageEvidence(hasMemory: boolean, webEvidence: MessageWebEvidence | undefined, t: Translate): string {
  const parts: string[] = [];
  if (hasMemory) {
    parts.push(t("Used memory"));
  }
  if (webEvidence) {
    const webParts: string[] = [];
    if (webEvidence.query || webEvidence.reason || webEvidence.sources.length > 0) {
      webParts.push(webEvidence.status === "blocked" ? "web_search blocked" : `web_search ${webEvidence.sources.length} sources`);
    }
    if (webEvidence.readUrls.length > 0) {
      webParts.push(`open_url ${webEvidence.readUrls.length} URLs`);
    }
    parts.push(webParts.join(" / ") || "web evidence");
  }
  return parts.join(" · ");
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
