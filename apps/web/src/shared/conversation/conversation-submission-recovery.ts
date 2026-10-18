export async function recoverSubmissionReceipt<T extends { readonly status: "accepted" | "unknown" }>(
  read: () => Promise<T>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T | undefined> {
  let lastUnknown: T | undefined;
  for (const delay of [0, 150, 300]) {
    if (delay) await wait(delay);
    try {
      const receipt = await read();
      if (receipt.status === "accepted") return receipt;
      lastUnknown = receipt;
    } catch {
      // A transient lookup failure cannot establish that the input was rejected.
    }
  }
  return lastUnknown;
}

export class UnconfirmedConversationSubmissionError extends Error {
  readonly idempotencyKey: string;
  readonly recoveryOnly: boolean;
  constructor(idempotencyKey: string, recoveryOnly = false) {
    super("Pending confirmation");
    this.idempotencyKey = idempotencyKey;
    this.recoveryOnly = recoveryOnly;
    this.name = "UnconfirmedConversationSubmissionError";
  }
}

export class RecoveredConversationSubmissionError extends Error {
  readonly originalBody: string;
  constructor(originalBody: string) {
    super("Message sent");
    this.originalBody = originalBody;
    this.name = "RecoveredConversationSubmissionError";
  }
}

export function submissionWasRejected(error: unknown, receipt?: { readonly status: "accepted" | "unknown" }): boolean {
  return receipt?.status === "unknown" && error instanceof Error && "status" in error && typeof error.status === "number"
    && error.status >= 400 && error.status < 500 && error.status !== 408;
}
import type { GuidanceLookupRecord, GuidanceLookupScope, createGuidanceLookupJournal } from "./conversation-submission-journal.js";


export type GuidanceReceipt<T> = { readonly status: "accepted"; readonly intervention: T } | { readonly status: "unknown" };

export async function resolveGuidanceSubmission<T>(input: {
  readonly scope: GuidanceLookupScope;
  readonly journal: ReturnType<typeof createGuidanceLookupJournal>;
  readonly prepare: () => GuidanceLookupRecord;
  readonly create: (record: GuidanceLookupRecord) => Promise<T>;
  readonly read: (record: GuidanceLookupRecord) => Promise<GuidanceReceipt<T>>;
  readonly wait?: (ms: number) => Promise<void>;
}): Promise<{ readonly intervention: T; readonly queryOnly: boolean }> {
  const forget = (key: string) => {
    try { input.journal.forget(input.scope, key); }
    catch { throw new UnconfirmedConversationSubmissionError(key, true); }
  };
  const pending = input.journal.read(input.scope);
  if (pending) {
    const receipt = await recoverSubmissionReceipt(() => input.read(pending), input.wait);
    if (receipt?.status !== "accepted") throw new UnconfirmedConversationSubmissionError(pending.key, true);
    forget(pending.key);
    return { intervention: receipt.intervention, queryOnly: true };
  }
  const record = input.prepare();
  input.journal.remember(input.scope, record);
  let intervention: T;
  try {
    intervention = await input.create(record);
  } catch (error) {
    const receipt = await recoverSubmissionReceipt(() => input.read(record), input.wait);
    if (receipt?.status === "accepted") {
      intervention = receipt.intervention;
    } else if (submissionWasRejected(error, receipt)) {
      forget(record.key);
      throw error;
    } else {
      throw new UnconfirmedConversationSubmissionError(record.key);
    }
  }
  forget(record.key);
  return { intervention, queryOnly: false };
}
