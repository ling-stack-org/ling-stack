import { createHash } from "node:crypto";
import type { NativeWorkIntakeSourceKind } from "@ling-stack/contracts";
import type { Task } from "./workspace-types.js";

export function nativeWorkIntakeReceiptId(kind: NativeWorkIntakeSourceKind, sourceEventId: string): string {
  return `intake_${createHash("sha256").update(JSON.stringify([kind, sourceEventId])).digest("hex")}`;
}

export function nativeTaskIntakeRevision(task: Task): string {
  return createHash("sha256").update(JSON.stringify([
    task.channelId, task.title, task.prompt, task.assigneeTeammateId, task.requestedSkillId, task.attachmentIds, task.createdAt,
  ])).digest("hex");
}
