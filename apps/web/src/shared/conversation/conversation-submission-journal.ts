export interface SubmissionLookupScope {
  readonly cwd: string;
  readonly surface: "normal" | "channel" | "private";
  readonly ownerId?: string;
  readonly threadId?: string;
}

type LookupStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createSubmissionLookupJournal(storage: LookupStorage) {
  const storageKey = (scope: SubmissionLookupScope): string => `ling-stack.submission-lookup.v1:${JSON.stringify([
    scope.cwd.trim(), scope.surface, scope.ownerId ?? "", scope.threadId ?? "",
  ])}`;
  const active = new Map<string, Set<string>>();
  const validKey = (key: unknown): key is string => typeof key === "string" && key.length > 0
    && key.length <= 200 && !/[\r\n]/.test(key);
  const readKeys = (scope: SubmissionLookupScope): string[] => {
    const value = storage.getItem(storageKey(scope));
    if (!value) return [];
    let keys: unknown;
    try { keys = value.startsWith("[") ? JSON.parse(value) : [value]; }
    catch { throw new Error("Pending confirmation"); }
    if (!Array.isArray(keys) || !keys.length || !keys.every(validKey) || new Set(keys).size !== keys.length) {
      throw new Error("Pending confirmation");
    }
    return keys;
  };
  const writeKeys = (scope: SubmissionLookupScope, keys: readonly string[]): void => {
    if (!keys.length) storage.removeItem(storageKey(scope));
    else storage.setItem(storageKey(scope), keys.length === 1 ? keys[0]! : JSON.stringify(keys));
  };
  const remember = (scope: SubmissionLookupScope, key: string): void => {
    if (!validKey(key)) throw new Error("Pending confirmation");
    const keys = readKeys(scope);
    // Persist every native lookup pointer, never message content or authorization.
    if (!keys.includes(key)) writeKeys(scope, [...keys, key]);
  };
  const finish = (scope: SubmissionLookupScope, key: string): void => {
    const owner = storageKey(scope), requests = active.get(owner);
    requests?.delete(key);
    if (!requests?.size) active.delete(owner);
  };
  return {
    read(scope: SubmissionLookupScope): string | undefined {
      return readKeys(scope).find(key => !active.get(storageKey(scope))?.has(key));
    },
    remember,
    begin(scope: SubmissionLookupScope, key: string): void {
      remember(scope, key);
      const owner = storageKey(scope), requests = active.get(owner) ?? new Set<string>();
      requests.add(key);
      active.set(owner, requests);
    },
    finish,
    forget(scope: SubmissionLookupScope, key: string): void {
      writeKeys(scope, readKeys(scope).filter(candidate => candidate !== key));
      finish(scope, key);
    },
  };
}

export const submissionLookupJournal = createSubmissionLookupJournal({
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
});

export interface GuidanceLookupScope {
  readonly cwd: string;
  readonly surface: "normal" | "private" | "run";
  readonly ownerId: string;
}

export interface GuidanceLookupRecord {
  readonly key: string;
  readonly sourceId: string;
  readonly threadId: string;
  readonly mode: "queue_followup" | "interrupt_redirect";
}

export function createGuidanceLookupJournal(storage: LookupStorage) {
  const storageKey = (scope: GuidanceLookupScope) => `ling-stack.guidance-lookup.v1:${JSON.stringify([
    scope.cwd.trim(), scope.surface, scope.ownerId,
  ])}`;
  return {
    read(scope: GuidanceLookupScope): GuidanceLookupRecord | undefined {
      const value = storage.getItem(storageKey(scope));
      if (!value) return undefined;
      let record: unknown;
      try { record = JSON.parse(value); }
      catch { throw new Error("Pending confirmation"); }
      if (!record || typeof record !== "object" || !("key" in record) || typeof record.key !== "string" || !record.key
        || !("sourceId" in record) || typeof record.sourceId !== "string" || !record.sourceId
        || !("threadId" in record) || typeof record.threadId !== "string" || !record.threadId
        || !("mode" in record) || (record.mode !== "queue_followup" && record.mode !== "interrupt_redirect")) {
        throw new Error("Pending confirmation");
      }
      return { key: record.key, sourceId: record.sourceId, threadId: record.threadId, mode: record.mode };
    },
    remember(scope: GuidanceLookupScope, record: GuidanceLookupRecord): void {
      // Persist only the original query pointer, not draft text, files or permissions.
      storage.setItem(storageKey(scope), JSON.stringify(record));
    },
    forget(scope: GuidanceLookupScope, key: string): void {
      const value = storage.getItem(storageKey(scope));
      if (value && JSON.parse(value).key === key) storage.removeItem(storageKey(scope));
    },
  };
}

export const guidanceLookupJournal = createGuidanceLookupJournal({
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
});
