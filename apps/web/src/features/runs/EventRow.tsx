import { useI18n } from "../../i18n.js";
import { formatEventData, formatEventPreview, readDataBoolean } from "../../lib/data.js";
import type { RunEventEnvelope } from "../../types.js";

export function EventRow({ event }: { readonly event: RunEventEnvelope }): JSX.Element {
  const { t } = useI18n();
  const preview = formatEventPreview(event.data);
  const payloadOpen = event.type === "run_error" || event.type === "result" || (event.type === "tool_end" && readDataBoolean(event.data, "isError"));

  return (
    <article className={`event-row ${event.type}`}>
      <div className="event-seq">#{event.seq}</div>
      <div className="event-body">
        <div className="event-head">
          <span>{event.type}</span>
          <time>{new Date(event.ts).toLocaleTimeString()}</time>
        </div>
        <details className="event-payload" open={payloadOpen}>
          <summary>
            <span>{preview || t("Payload")}</span>
          </summary>
          <pre>{formatEventData(event.data)}</pre>
        </details>
      </div>
    </article>
  );
}
