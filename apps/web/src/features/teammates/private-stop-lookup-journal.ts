export interface PrivateStopLookupScope {
  readonly cwd: string;
  readonly teammateId: string;
  readonly threadId: string;
}

export interface PrivateStopLookupRecord {
  readonly workUnitId: string;
  readonly messageId: string;
  readonly linkedRunId?: string;
  readonly attemptId?: string;
}

type LookupStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sameOperation(left: PrivateStopLookupRecord, right: PrivateStopLookupRecord): boolean {
  return left.workUnitId === right.workUnitId && left.messageId === right.messageId
    && left.linkedRunId === right.linkedRunId && left.attemptId === right.attemptId;
}

export function createPrivateStopLookupJournal(storage: LookupStorage) {
  const storageKey = (scope: PrivateStopLookupScope) => `ling-stack.private-stop-lookup.v1:${JSON.stringify([
    scope.cwd.trim(), scope.teammateId, scope.threadId,
  ])}`;
  function read(scope: PrivateStopLookupScope): readonly PrivateStopLookupRecord[] {
    const value = storage.getItem(storageKey(scope));
    if (!value) return [];
    const records: unknown = JSON.parse(value);
    const isId = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\r\n]/.test(id);
    if (!Array.isArray(records) || records.length > 100 || records.some(record => !record || typeof record !== "object"
      || !isId(record.workUnitId) || !isId(record.messageId)
      || (record.linkedRunId !== undefined && !isId(record.linkedRunId))
      || (record.attemptId !== undefined && !isId(record.attemptId)))) throw new Error("Invalid stop lookup");
    return records.map(({ workUnitId, messageId, linkedRunId, attemptId }) => ({ workUnitId, messageId, linkedRunId, attemptId }));
  }
  return {
    read,
    remember(scope: PrivateStopLookupScope, record: PrivateStopLookupRecord): void {
      const records = read(scope);
      if (records.some(item => sameOperation(item, record))) return;
      if (records.length >= 100) throw new Error("Too many pending stop lookups");
      // Persist query pointers only; a stored pointer never authorizes cancellation.
      storage.setItem(storageKey(scope), JSON.stringify([...records, {
        workUnitId: record.workUnitId, messageId: record.messageId,
        linkedRunId: record.linkedRunId, attemptId: record.attemptId,
      }]));
    },
    forget(scope: PrivateStopLookupScope, record: PrivateStopLookupRecord): void {
      const records = read(scope).filter(item => !sameOperation(item, record));
      if (records.length) storage.setItem(storageKey(scope), JSON.stringify(records));
      else storage.removeItem(storageKey(scope));
    },
  };
}

export const privateStopLookupJournal = createPrivateStopLookupJournal({
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
});
