import { isDeepStrictEqual } from "node:util";
import { CodexRpcError, type CodexNotification } from "./duplex.js";
import type { FileUpdateChange } from "./protocol/v2/FileUpdateChange.js";
import type { FileChangePatchUpdatedNotification } from "./protocol/v2/FileChangePatchUpdatedNotification.js";

interface FileItem { readonly changes: readonly FileUpdateChange[]; readonly revision: number }
interface Entry { readonly turn: string; readonly item?: FileItem; readonly started: boolean; readonly bytes: number }

/** Receipt-time context, independent of ordered UI observers. Terminal identities cannot be reopened. */
export class CodexFileChangeContext {
  readonly #entries = new Map<string, Entry>();
  readonly #completedTurns = new Set<string>();
  readonly #limits: { items: number; bytes: number };
  #bytes = 0;

  constructor(limits: { items?: number; bytes?: number } = {}) {
    this.#limits = { items: limits.items ?? 256, bytes: limits.bytes ?? 4 * 1024 * 1024 };
    if (Object.values(this.#limits).some(value => !Number.isSafeInteger(value) || value < 1 || value > 2 ** 30)) {
      throw new CodexRpcError("capacity_exceeded");
    }
  }

  receive(message: CodexNotification): void {
    const params = message.params;
    if (!["item/started", "item/completed", "turn/completed", "item/fileChange/patchUpdated"].includes(message.method)) return;
    if (!record(params) || !id(params.threadId)) throw new CodexRpcError("protocol_error");
    if (message.method === "turn/completed") {
      if (!record(params.turn) || !id(params.turn.id)) throw new CodexRpcError("protocol_error");
      const turn = JSON.stringify([params.threadId, params.turn.id]);
      if (!this.#completedTurns.has(turn) && this.#completedTurns.size >= this.#limits.items) throw new CodexRpcError("capacity_exceeded");
      this.#completedTurns.add(turn);
      for (const [key, entry] of this.#entries) if (entry.turn === turn) {
        this.#bytes -= entry.bytes;
        this.#entries.delete(key);
      }
      return;
    }
    if (message.method === "item/fileChange/patchUpdated") {
      if (!patchUpdate(params)) throw new CodexRpcError("protocol_error");
      this.#snapshot(params.threadId, params.turnId, params.itemId, params.changes, false);
      return;
    }
    if (!id(params.turnId) || !record(params.item) || !id(params.item.id)) throw new CodexRpcError("protocol_error");
    const turn = JSON.stringify([params.threadId, params.turnId]);
    const key = JSON.stringify([params.threadId, params.turnId, params.item.id]);
    const previous = this.#entries.get(key);
    if (params.item.type !== "fileChange" && !previous) return;
    if (message.method === "item/completed") {
      this.#put(key, { turn, started: false, bytes: 0 });
      return;
    }
    if (params.item.type !== "fileChange" || params.item.status !== "inProgress"
      || !fileChanges(params.item.changes)) throw new CodexRpcError("protocol_error");
    this.#snapshot(params.threadId, params.turnId, params.item.id, params.item.changes, true);
  }

  read(threadId: string, turnId: string, itemId: string): FileItem | undefined {
    const entry = this.#entries.get(JSON.stringify([threadId, turnId, itemId]));
    return entry?.started && entry.item?.changes.length ? structuredClone(entry.item) : undefined;
  }

  clear(): void { this.#entries.clear(); this.#completedTurns.clear(); this.#bytes = 0; }

  #snapshot(threadId: string, turnId: string, itemId: string, changes: readonly FileUpdateChange[], started: boolean): void {
    const turn = JSON.stringify([threadId, turnId]);
    const key = JSON.stringify([threadId, turnId, itemId]);
    const previous = this.#entries.get(key);
    if (this.#completedTurns.has(turn) || (previous && !previous.item)) throw new CodexRpcError("protocol_error");
    const equal = previous && isDeepStrictEqual(previous.item!.changes, changes);
    if (equal && (!started || previous.started)) return;
    if (started && previous?.started) throw new CodexRpcError("protocol_error");
    // Streaming input is not a finalized operation. Revisions fence changed-then-restored previews.
    const revision = (previous?.item?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new CodexRpcError("capacity_exceeded");
    const item: FileItem = { changes: structuredClone(changes), revision };
    this.#put(key, { turn, item, started, bytes: Buffer.byteLength(JSON.stringify(item), "utf8") });
  }

  #put(key: string, entry: Entry): void {
    const previous = this.#entries.get(key);
    const bytes = this.#bytes - (previous?.bytes ?? 0) + entry.bytes;
    if ((!previous && this.#entries.size >= this.#limits.items) || bytes > this.#limits.bytes) throw new CodexRpcError("capacity_exceeded");
    this.#entries.set(key, entry);
    this.#bytes = bytes;
  }
}

function patchUpdate(value: Record<string, unknown>): value is Record<string, unknown> & FileChangePatchUpdatedNotification {
  return id(value.threadId) && id(value.turnId) && id(value.itemId) && fileChanges(value.changes);
}
function fileChanges(value: unknown): value is FileUpdateChange[] {
  return Array.isArray(value) && value.length <= 256 && value.every(fileChange);
}
function fileChange(value: unknown): value is FileUpdateChange {
  if (!record(value) || typeof value.path !== "string" || !value.path || /[\x00-\x1f\x7f]/.test(value.path)
    || typeof value.diff !== "string" || !record(value.kind)) return false;
  if (value.kind.type === "add" || value.kind.type === "delete") return value.kind.move_path == null;
  return value.kind.type === "update" && (value.kind.move_path === null
    || (typeof value.kind.move_path === "string" && !!value.kind.move_path && !/[\x00-\x1f\x7f]/.test(value.kind.move_path)));
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value); }
