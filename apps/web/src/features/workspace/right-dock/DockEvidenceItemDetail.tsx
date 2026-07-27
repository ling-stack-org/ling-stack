import type { DockEvidenceGroupView } from "../../../shared/conversation/index.js";

export function DockEvidenceItemDetail({
  groupLabel,
  item,
  labels,
}: {
  readonly groupLabel: string;
  readonly item: DockEvidenceGroupView["items"][number];
  readonly labels: {
    readonly group: string;
    readonly summary: string;
    readonly status: string;
    readonly source: string;
    readonly link: string;
    readonly requestedUrl: string;
    readonly finalUrl: string;
    readonly failureReason: string;
    readonly time: string;
  };
}): JSX.Element {
  const href = safeEvidenceHref(item.href);
  return (
    <dl className="right-dock-detail-list">
      <div>
        <dt>{labels.group}</dt>
        <dd>{groupLabel}</dd>
      </div>
      {item.statusLabel ? (
        <div>
          <dt>{labels.status}</dt>
          <dd>{item.statusLabel}</dd>
        </div>
      ) : null}
      {item.summary ? (
        <div>
          <dt>{labels.summary}</dt>
          <dd>{item.summary}</dd>
        </div>
      ) : null}
      {item.href ? (
        <div>
          <dt>{labels.link}</dt>
          <dd>
            {href ? (
              <a className="right-dock-evidence-link" href={href} target="_blank" rel="noreferrer">
                {item.href}
              </a>
            ) : item.href}
          </dd>
        </div>
      ) : null}
      {item.originalUrl && item.originalUrl !== item.href ? (
        <div>
          <dt>{labels.requestedUrl}</dt>
          <dd>{item.originalUrl}</dd>
        </div>
      ) : null}
      {item.finalUrl && item.finalUrl !== item.originalUrl ? (
        <div>
          <dt>{labels.finalUrl}</dt>
          <dd>{item.finalUrl}</dd>
        </div>
      ) : null}
      {item.failureReason ? (
        <div>
          <dt>{labels.failureReason}</dt>
          <dd>{item.failureReason}</dd>
        </div>
      ) : null}
      {item.sourceLabel ? (
        <div>
          <dt>{labels.source}</dt>
          <dd>{item.sourceLabel}</dd>
        </div>
      ) : null}
      {item.timestampLabel ? (
        <div>
          <dt>{labels.time}</dt>
          <dd>{item.timestampLabel}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function safeEvidenceHref(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
