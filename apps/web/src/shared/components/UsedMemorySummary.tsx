import { Database } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { MemoryObject, UsedMemoryEvent } from "../../types.js";

export function UsedMemorySummaryLabel({
  events,
}: {
  readonly events: readonly UsedMemoryEvent[];
}): JSX.Element | null {
  const { t } = useI18n();
  const memoryCount = uniqueMemoryIds(events).length;
  if (events.length === 0 || memoryCount === 0) {
    return null;
  }
  return (
    <span className="used-memory-summary-label">
      <Database size={12} />
      <span>{formatUsedMemoryCount(t, memoryCount)}</span>
      <small>{formatDateTime(latestUsedMemoryEvent(events).createdAt)}</small>
    </span>
  );
}

export function UsedMemorySummary({
  events,
  memoryById,
  maxItems = 4,
  compact = false,
  variant = "panel",
}: {
  readonly events: readonly UsedMemoryEvent[];
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly maxItems?: number;
  readonly compact?: boolean;
  readonly variant?: "panel" | "footer" | "inline";
}): JSX.Element | null {
  const { t } = useI18n();
  const allMemoryIds = uniqueMemoryIds(events);
  const memoryIds = allMemoryIds.slice(0, maxItems);
  if (events.length === 0 || allMemoryIds.length === 0) {
    return null;
  }

  const overflowCount = Math.max(0, allMemoryIds.length - memoryIds.length);
  const latestEvent = latestUsedMemoryEvent(events);
  const className = `used-memory-summary${compact ? " compact" : ""}${variant === "footer" ? " footer" : ""}${variant === "inline" ? " inline" : ""}`;
  if (variant === "inline") {
    return (
      <div className={className} aria-label={t("Used memory")}>
        <ul>
          {memoryIds.map((memoryId) => {
            const memory = memoryById.get(memoryId);
            const sourceSummary = memory ? formatSourceRefs(memory) : "";
            return (
              <li key={memoryId}>
                <span>{memory?.title ?? shortMemoryId(memoryId)}</span>
                {memory ? <small>{`${t("Scope")}: ${formatMemoryScope(memory)}`}</small> : null}
                {sourceSummary ? <small>{`${t("Source")}: ${sourceSummary}`}</small> : null}
              </li>
            );
          })}
        </ul>
        {overflowCount > 0 ? <small className="used-memory-overflow">{t("+{count} more memory items", { count: overflowCount })}</small> : null}
      </div>
    );
  }
  if (variant === "footer") {
    const recallQueries = uniqueStrings(events.map((event) => event.recallQuery.trim()).filter(Boolean)).slice(0, 2);
    return (
      <details className={className} aria-label={t("Used memory")}>
        <summary>
          <span className="used-memory-summary-footer-label">
            <Database size={12} />
            {formatUsedMemoryCount(t, allMemoryIds.length)}
          </span>
          <small>{formatDateTime(latestEvent.createdAt)}</small>
        </summary>
        <div className="used-memory-summary-footer-body">
          <ul>
            {memoryIds.map((memoryId) => {
              const memory = memoryById.get(memoryId);
              const sourceSummary = memory ? formatSourceRefs(memory) : "";
              return (
                <li key={memoryId}>
                  <span>{memory?.title ?? shortMemoryId(memoryId)}</span>
                  {memory ? <small>{`${t("Scope")}: ${formatMemoryScope(memory)}`}</small> : null}
                  {sourceSummary ? <small>{`${t("Source")}: ${sourceSummary}`}</small> : null}
                </li>
              );
            })}
          </ul>
          {overflowCount > 0 ? <small className="used-memory-overflow">{t("+{count} more memory items", { count: overflowCount })}</small> : null}
          {recallQueries.length > 0 ? (
            <small className="used-memory-recall-query">{`${t("Recall")}: ${recallQueries.join(" · ")}`}</small>
          ) : null}
        </div>
      </details>
    );
  }

  return (
    <div className={className} aria-label={t("Used memory")}>
      <div className="used-memory-summary-head">
        <span>
          <Database size={13} />
          <strong>{t("Used memory")}</strong>
        </span>
        <small>{formatDateTime(latestEvent.createdAt)}</small>
      </div>
      <ul>
        {memoryIds.map((memoryId) => {
          const memory = memoryById.get(memoryId);
          return (
            <li key={memoryId}>
              <span>{memory?.title ?? shortMemoryId(memoryId)}</span>
              {memory ? <small>{`${memory.scopeType}:${memory.ownerId}`}</small> : null}
            </li>
          );
        })}
      </ul>
      {overflowCount > 0 ? <small className="used-memory-overflow">{t("+{count} more memory items", { count: overflowCount })}</small> : null}
    </div>
  );
}

export function filterUsedMemoryEventsByResponse(
  events: readonly UsedMemoryEvent[],
  responseId: string | undefined,
): readonly UsedMemoryEvent[] {
  if (!responseId) {
    return [];
  }
  return events.filter((event) => event.responseId === responseId);
}

function uniqueMemoryIds(events: readonly UsedMemoryEvent[]): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    for (const memoryId of event.memoryIds) {
      if (seen.has(memoryId)) {
        continue;
      }
      seen.add(memoryId);
      ids.push(memoryId);
    }
  }
  return ids;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function latestUsedMemoryEvent(events: readonly UsedMemoryEvent[]): UsedMemoryEvent {
  return [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? events[0];
}

function formatUsedMemoryCount(t: ReturnType<typeof useI18n>["t"], count: number): string {
  return count === 1 ? t("Used 1 memory") : t("Used {count} memories", { count });
}

function shortMemoryId(memoryId: string): string {
  return memoryId.length > 24 ? `${memoryId.slice(0, 20)}...` : memoryId;
}

function formatMemoryScope(memory: MemoryObject): string {
  return `${memory.scopeType}:${memory.ownerId}`;
}

function formatSourceRefs(memory: MemoryObject): string {
  return memory.sourceRefs
    .slice(0, 2)
    .map((sourceRef) => sourceRef.label?.trim() || sourceRef.url?.trim() || `${sourceRef.type}:${sourceRef.id}`)
    .filter(Boolean)
    .join(" · ");
}
