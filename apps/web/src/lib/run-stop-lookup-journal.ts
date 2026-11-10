export interface RunStopLookupRecord {
  readonly cwd: string;
  readonly runId: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
}

type LookupStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sameOperation(left: RunStopLookupRecord, right: RunStopLookupRecord): boolean {
  return left.cwd === right.cwd && left.runId === right.runId
    && left.workUnitId === right.workUnitId && left.attemptId === right.attemptId;
}

export function createRunStopLookupJournal(storage: LookupStorage) {
  const storageKey = (workspaceCwd: string) => `ling-stack.run-stop-lookup.v1:${JSON.stringify(workspaceCwd.trim())}`;
  function read(workspaceCwd: string): readonly RunStopLookupRecord[] {
    const value = storage.getItem(storageKey(workspaceCwd));
    if (!value) return [];
    const records: unknown = JSON.parse(value);
    const isId = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\r\n]/.test(id);
    if (!Array.isArray(records) || records.length > 100 || records.some(record => !record || typeof record !== "object"
      || typeof record.cwd !== "string" || !record.cwd.trim() || record.cwd.length > 4096 || /[\r\n]/.test(record.cwd)
      || !isId(record.runId) || (record.workUnitId !== undefined && !isId(record.workUnitId))
      || (record.attemptId !== undefined && !isId(record.attemptId)))) throw new Error("Invalid stop lookup");
    return records.map(({ cwd, runId, workUnitId, attemptId }) => ({ cwd, runId, workUnitId, attemptId }));
  }
  return {
    read,
    remember(workspaceCwd: string, record: RunStopLookupRecord): void {
      const records = read(workspaceCwd);
      if (records.some(item => sameOperation(item, record))) return;
      if (records.length >= 100) throw new Error("Too many pending stop lookups");
      // A persisted pointer permits reads only, never cancellation replay.
      storage.setItem(storageKey(workspaceCwd), JSON.stringify([...records, {
        cwd: record.cwd, runId: record.runId, workUnitId: record.workUnitId, attemptId: record.attemptId,
      }]));
    },
    forget(workspaceCwd: string, record: RunStopLookupRecord): void {
      const records = read(workspaceCwd).filter(item => !sameOperation(item, record));
      if (records.length) storage.setItem(storageKey(workspaceCwd), JSON.stringify(records));
      else storage.removeItem(storageKey(workspaceCwd));
    },
  };
}

export const runStopLookupJournal = createRunStopLookupJournal({
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
});
