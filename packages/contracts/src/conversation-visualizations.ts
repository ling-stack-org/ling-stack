import { scanInteractiveHtml } from "./artifacts.js";

export const CONVERSATION_VISUALIZATION_MAX_BYTES = 5_000_000;
export const CONVERSATION_VISUALIZATION_MAX_PER_RUN = 4;
export const CONVERSATION_VISUALIZATION_MAX_HEIGHT = 640;

const referencePrefix = "#ling-visualization-v1-";
const artifactIdPattern = /^viz_[a-f0-9]{32}$/u;

export interface ConversationVisualizationInput {
  readonly title: string;
  readonly summary: string;
  readonly html: string;
  readonly layout: "standard" | "wide";
  readonly interaction: "native" | "script";
  readonly preferredHeight: number;
}

export interface ConversationVisualization extends ConversationVisualizationInput {
  readonly artifactId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ConversationVisualizationReference {
  readonly artifactId: string;
  readonly label: string;
}

export function isConversationVisualizationId(value: unknown): value is string {
  return typeof value === "string" && artifactIdPattern.test(value);
}

export function readConversationVisualizationId(url: string): string | undefined {
  if (!url.startsWith(referencePrefix)) return undefined;
  const id = url.slice(referencePrefix.length);
  return isConversationVisualizationId(id) ? id : undefined;
}

export function conversationVisualizationMarkdown({ artifactId, label }: ConversationVisualizationReference): string {
  return "[" + label.replace(/[\\`*_{}\[\]<>!|~&]/gu, "\\$&") + "](" + referencePrefix + artifactId + ")";
}

export function normalizeConversationVisualization(value: unknown): ConversationVisualizationInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !["title", "summary", "html", "layout", "interaction", "preferredHeight"].includes(key))) {
    return undefined;
  }
  const { layout = "standard", interaction = "native", preferredHeight = 360, html } = fields;
  const title = normalizedText(fields.title, 240);
  const summary = normalizedText(fields.summary, 768);
  if (!title || !summary || typeof html !== "string" || !html.trim() || /[\u0000\p{Cs}]/u.test(html)
    || (layout !== "standard" && layout !== "wide") || (interaction !== "native" && interaction !== "script")
    || typeof preferredHeight !== "number" || !Number.isInteger(preferredHeight)
    || preferredHeight < 160 || preferredHeight > CONVERSATION_VISUALIZATION_MAX_HEIGHT
    || !scanInteractiveHtml(html, CONVERSATION_VISUALIZATION_MAX_BYTES).ok) return undefined;
  return { title, summary, html, layout, interaction, preferredHeight };
}

function normalizedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || /[\p{Cc}\p{Cs}]/u.test(value)) return undefined;
  const text = value.trim();
  return text && new TextEncoder().encode(text).length <= maxBytes ? text : undefined;
}
