import type { ConversationReadingAnchor } from "../blocks/conversation-reading-anchor.js";
import type { ConversationDisclosureKind } from "./conversation-view-store.js";

export interface SavedConversationViewport {
  readonly following: boolean;
  readonly anchor?: ConversationReadingAnchor;
}

interface ReadingSnapshot {
  readonly updatedAt: number;
  readonly viewport?: SavedConversationViewport;
  readonly disclosures: readonly (readonly [ConversationDisclosureKind, string, boolean])[];
}

type ReadingStorage = Pick<Storage, "getItem" | "setItem">;
const storageKey = "ling-stack.conversation-reading.v1";
const ttlMs = 30 * 24 * 60 * 60 * 1000;
const maxEntries = 100;
const maxDisclosures = 128;
const maxBytes = 512 * 1024;

/** Browser/Electron storage partition supplies local-profile isolation. */
export function conversationReadingScope(daemonUrl: string, cwd: string, surface: string, threadId: string | undefined): string | undefined {
  if (!cwd.trim() || !surface || !threadId) return undefined;
  try {
    const url = new URL(daemonUrl);
    // Never retain URL credentials, tokens, fragments or discovery parameters.
    return JSON.stringify([url.origin + url.pathname, cwd.trim(), surface, threadId]);
  } catch {
    return undefined;
  }
}

/** View preferences only. No transcript, capability, permission or execution state. */
export function createConversationReadingStorage(
  storage: () => ReadingStorage | undefined = () => globalThis.localStorage,
  now: () => number = Date.now,
) {
  function readEntries(): Map<string, ReadingSnapshot> {
    try {
      const raw = storage()?.getItem(storageKey);
      if (!raw || raw.length * 2 > maxBytes) return new Map();
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return new Map();
      const entries = new Map<string, ReadingSnapshot>();
      for (const entry of value.entries.slice(0, maxEntries)) {
        if (!Array.isArray(entry) || !validId(entry[0], 4096)) continue;
        const snapshot = parseSnapshot(entry[1], now());
        if (snapshot) entries.set(entry[0], snapshot);
      }
      return entries;
    } catch {
      return new Map();
    }
  }

  function update(scope: string | undefined, change: (previous: ReadingSnapshot) => ReadingSnapshot): void {
    if (!scope || !validId(scope, 4096)) return;
    try {
      const entries = readEntries();
      const changed = change(entries.get(scope) ?? { updatedAt: now(), disclosures: [] });
      entries.delete(scope);
      const retained: Array<[string, ReadingSnapshot]> = [[scope, changed], ...entries];
      retained.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      retained.splice(maxEntries);
      let raw = JSON.stringify({ version: 1, entries: retained });
      while (raw.length * 2 > maxBytes && retained.length) {
        retained.pop();
        raw = JSON.stringify({ version: 1, entries: retained });
      }
      storage()?.setItem(storageKey, raw);
    } catch {
      // Storage restrictions/quota never prevent reading, disclosure or execution.
    }
  }

  return {
    read(scope: string | undefined): ReadingSnapshot | undefined {
      return scope ? readEntries().get(scope) : undefined;
    },
    readDisclosure(scope: string | undefined, kind: ConversationDisclosureKind, id: string): boolean | undefined {
      return scope ? readEntries().get(scope)?.disclosures.find(entry => entry[0] === kind && entry[1] === id)?.[2] : undefined;
    },
    writeDisclosure(scope: string | undefined, kind: ConversationDisclosureKind, id: string, expanded: boolean): void {
      if (!validId(id)) return;
      update(scope, previous => ({ ...previous, updatedAt: now(), disclosures: [
        ...previous.disclosures.filter(entry => entry[0] !== kind || entry[1] !== id),
        [kind, id, expanded] as const,
      ].slice(-maxDisclosures) }));
    },
    writeViewport(scope: string | undefined, viewport: SavedConversationViewport): void {
      const parsed = parseViewport(viewport);
      if (parsed) update(scope, previous => ({ ...previous, updatedAt: now(), viewport: parsed }));
    },
  };
}

export const conversationReadingStorage = createConversationReadingStorage();

function parseSnapshot(value: unknown, now: number): ReadingSnapshot | undefined {
  if (!isRecord(value) || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)
    || value.updatedAt < now - ttlMs || value.updatedAt > now + 60_000 || !Array.isArray(value.disclosures)) return undefined;
  const disclosures: Array<readonly [ConversationDisclosureKind, string, boolean]> = [];
  for (const entry of value.disclosures.slice(-maxDisclosures)) {
    if (Array.isArray(entry) && (entry[0] === "block" || entry[0] === "span") && validId(entry[1]) && typeof entry[2] === "boolean") {
      disclosures.push([entry[0], entry[1], entry[2]]);
    }
  }
  return { updatedAt: value.updatedAt, disclosures, viewport: parseViewport(value.viewport) };
}

function parseViewport(value: unknown): SavedConversationViewport | undefined {
  if (!isRecord(value) || typeof value.following !== "boolean") return undefined;
  if (value.following) return { following: true };
  const anchor = value.anchor;
  if (!isRecord(anchor) || !validId(anchor.rowKey) || typeof anchor.offsetTop !== "number" || !Number.isFinite(anchor.offsetTop)
    || Math.abs(anchor.offsetTop) > 10_000_000 || (anchor.parentSubAgentId !== undefined && !validId(anchor.parentSubAgentId))) return undefined;
  return { following: false, anchor: {
    rowKey: anchor.rowKey, offsetTop: anchor.offsetTop,
    ...(typeof anchor.parentSubAgentId === "string" ? { parentSubAgentId: anchor.parentSubAgentId } : {}),
  } };
}

function validId(value: unknown, maxLength = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
