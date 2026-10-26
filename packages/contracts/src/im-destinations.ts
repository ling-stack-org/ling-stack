/**
 * IM destination contract (ux-gap-roadmap-04).
 *
 * IM delivery is an external destination attached to run notifications, not a
 * new channel type. V1 is outbound-only via each platform's incoming-webhook
 * bot; secrets are stored as env:/keychain: refs, never raw URLs.
 */

export type ImDestinationProvider = "feishu" | "wecom" | "dingtalk" | "slack";

export interface ImDestination {
  readonly id: string;
  readonly label: string;
  readonly provider: ImDestinationProvider;
  /** env:NAME or keychain:NAME ref resolving to the incoming webhook URL. */
  readonly webhookRef: string;
  /** Optional signing secret ref (DingTalk sign, Feishu sign). */
  readonly secretRef?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ImDestinationsResponse {
  readonly schemaVersion: 1;
  readonly destinations: readonly ImDestination[];
}

export interface DestinationMessage {
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly severity: "info" | "warning" | "danger";
  /** Deep link back to the run; included when the surface can render it. */
  readonly link?: string;
}

export interface DestinationDispatchResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
}

const WEBHOOK_HOST_SUFFIXES: Readonly<Record<ImDestinationProvider, readonly string[]>> = {
  feishu: ["open.feishu.cn", "open.larksuite.com"],
  wecom: ["qyapi.weixin.qq.com"],
  dingtalk: ["oapi.dingtalk.com"],
  slack: ["hooks.slack.com"],
};

export function isAllowedImWebhookUrl(provider: ImDestinationProvider, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const suffixes = WEBHOOK_HOST_SUFFIXES[provider];
    return suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export interface ImWebhookPayload {
  readonly body: string;
  readonly contentType: "application/json";
}

export function buildFeishuPayload(message: DestinationMessage): ImWebhookPayload {
  return {
    contentType: "application/json",
    body: JSON.stringify({
      msg_type: "interactive",
      card: {
        header: {
          title: { tag: "plain_text", content: message.title },
          template: message.severity === "danger" ? "red" : message.severity === "warning" ? "orange" : "blue",
        },
        elements: [
          { tag: "div", text: { tag: "lark_md", content: message.bodyMarkdown } },
          ...(message.link ? [{ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "View run" }, url: message.link, type: "primary" }] }] : []),
        ],
      },
    }),
  };
}

export function buildWecomPayload(message: DestinationMessage): ImWebhookPayload {
  return {
    contentType: "application/json",
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: {
        content: `**${message.title}**\n${message.bodyMarkdown}${message.link ? `\n[View run](${message.link})` : ""}`,
      },
    }),
  };
}

export function buildDingtalkPayload(message: DestinationMessage): ImWebhookPayload {
  return {
    contentType: "application/json",
    body: JSON.stringify({
      msgtype: "actionCard",
      actionCard: {
        title: message.title,
        text: `${message.bodyMarkdown}${message.link ? `\n\n[View run](${message.link})` : ""}`,
        hideAvatar: "0",
        btnOrientation: "0",
      },
    }),
  };
}

export function buildSlackPayload(message: DestinationMessage): ImWebhookPayload {
  const color = message.severity === "danger" ? "#dc2626" : message.severity === "warning" ? "#d97706" : "#2563eb";
  return {
    contentType: "application/json",
    body: JSON.stringify({
      attachments: [{
        color,
        title: message.title,
        text: message.bodyMarkdown,
        ...(message.link ? { title_link: message.link } : {}),
      }],
    }),
  };
}

export function buildImPayload(provider: ImDestinationProvider, message: DestinationMessage): ImWebhookPayload {
  switch (provider) {
    case "feishu": return buildFeishuPayload(message);
    case "wecom": return buildWecomPayload(message);
    case "dingtalk": return buildDingtalkPayload(message);
    case "slack": return buildSlackPayload(message);
  }
}
