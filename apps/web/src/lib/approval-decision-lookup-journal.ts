export interface ApprovalDecisionLookupScope {
  readonly daemonBaseUrl: string;
  readonly cwd: string;
}

export interface ApprovalDecisionLookup {
  readonly approvalId: string;
  readonly token: string;
}

type LookupStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function createApprovalDecisionLookupJournal(storage: LookupStorage) {
  const prefix = (scope: ApprovalDecisionLookupScope) =>
    `ling-stack.approval-decision-lookup.v1:${JSON.stringify([scope.daemonBaseUrl, scope.cwd.trim()])}:`;
  const validId = (value: string) => value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
  return {
    read(scope: ApprovalDecisionLookupScope): readonly ApprovalDecisionLookup[] {
      const start = prefix(scope);
      const records: ApprovalDecisionLookup[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(start)) continue;
        const approvalId = decodeURIComponent(key.slice(start.length));
        const token = storage.getItem(key);
        if (!validId(approvalId) || !token || !validId(token)) throw new Error("Pending confirmation");
        records.push({ approvalId, token });
      }
      return records;
    },
    remember(scope: ApprovalDecisionLookupScope, record: ApprovalDecisionLookup): void {
      if (!validId(record.approvalId) || !validId(record.token)) throw new Error("Pending confirmation");
      // Separate keys preserve concurrent decisions; only query pointers, never approval authority.
      storage.setItem(prefix(scope) + encodeURIComponent(record.approvalId), record.token);
    },
    forget(scope: ApprovalDecisionLookupScope, record: ApprovalDecisionLookup): void {
      const key = prefix(scope) + encodeURIComponent(record.approvalId);
      if (storage.getItem(key) === record.token) storage.removeItem(key);
    },
  };
}

export const approvalDecisionLookupJournal = createApprovalDecisionLookupJournal({
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
  key: index => window.localStorage.key(index),
  get length() { return window.localStorage.length; },
});
