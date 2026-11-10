import type { RunStore } from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";

/** A failed drain retains its durable notice for the next sweep; edits remain committed. */
export function flushSkillDefinitionRevisionNotices(store: RunStore, hub: ControlPlaneEventHub, cwd: string): void {
  try {
    for (const event of store.drainSkillDefinitionRevisionNotices(cwd, new Date().toISOString())) hub.publish(event);
  } catch {
    console.warn("skill_revision_notice_recovery_failed: durable notices remain recoverable");
  }
}
