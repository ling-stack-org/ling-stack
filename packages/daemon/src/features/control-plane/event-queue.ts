import type { ControlPlaneEvent } from "@ling-stack/core";

export function coalesceAndSortControlPlaneEvents(
  events: readonly ControlPlaneEvent[],
): ControlPlaneEvent[] {
  const preserved: ControlPlaneEvent[] = [];
  const coalesced = new Map<string, { event: ControlPlaneEvent; count: number }>();
  for (const event of events) {
    if (shouldPreserveEvent(event)) {
      preserved.push(event);
      continue;
    }
    const key = `${event.domain}:${event.entityType}:${event.entityId}:${event.action}`;
    const existing = coalesced.get(key);
    coalesced.set(key, existing ? { event, count: existing.count + 1 } : { event, count: 1 });
  }
  const bySeq = new Map<number, ControlPlaneEvent>();
  for (const event of preserved) bySeq.set(event.seq, event);
  for (const { event, count } of coalesced.values()) {
    bySeq.set(event.seq, {
      ...event,
      data: {
        ...event.data,
        summary: count > 1 ? "coalesced control-plane invalidations" : event.data.summary,
        count,
      },
    });
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function shouldPreserveEvent(event: ControlPlaneEvent): boolean {
  return event.action.startsWith("approval.")
    || event.action === "run.completed"
    || event.action === "run.cancelled";
}
