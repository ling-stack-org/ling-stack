import { Database } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { MemoryObject, UsedMemoryEvent } from "../../types.js";

export function UsedMemorySummary({
  events,
  memoryById,
  maxItems = 4,
  compact = false,
}: {
  readonly events: readonly UsedMemoryEvent[];
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly maxItems?: number;
  readonly compact?: boolean;
}): JSX.Element | null {
  const { t } = useI18n();
  const memoryIds = uniqueMemoryIds(events).slice(0, maxItems);
  if (events.length === 0 || memoryIds.length === 0) {
    return null;
  }

  const overflowCount = Math.max(0, uniqueMemoryIds(events).length - memoryIds.length);
  const latestEvent = events[0];
  return (
    <div className={`used-memory-summary${compact ? " compact" : ""}`} aria-label={t("Used memory")}>
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

function shortMemoryId(memoryId: string): string {
  return memoryId.length > 24 ? `${memoryId.slice(0, 20)}...` : memoryId;
}
