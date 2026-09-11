import type { CanonicalConversationItem } from "./canonical-transcript-projector.js";

/** Structural mirrors of the Host's public DTO. No runtime authority belongs here. */
export interface CanonicalUserInputRunEventPosition {
  readonly runId: string;
  readonly attemptId: string;
  readonly afterEventSequence: number;
  readonly afterEventId?: string;
}

export interface CanonicalUserInputSource {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly workUnitId: string;
  readonly participantId: string;
  readonly sourceItemId: string;
  readonly workflowStepId?: string;
}
interface AvailableInput {
  readonly availability: "available";
  readonly itemId: string;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly source: CanonicalUserInputSource;
  readonly runEventPosition?: CanonicalUserInputRunEventPosition;
}
export interface CanonicalUserInputRequest extends AvailableInput {
  readonly kind: "user_input_request";
  readonly status: "pending" | "answered" | "skipped" | "cancelled" | "expired" | "superseded";
  readonly statusRevision: number;
  readonly waitMode: "optional" | "required";
  readonly questions: readonly {
    readonly questionId: string;
    readonly prompt: string;
    readonly required: boolean;
    readonly allowFreeText: boolean;
    readonly options: readonly { readonly optionId: string; readonly label: string }[];
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}
export interface CanonicalUserInputAnswer extends AvailableInput {
  readonly kind: "user_input_answer";
  readonly answerId: string;
  readonly acceptedAt: string;
  readonly answers: readonly ({ readonly questionId: string; readonly prompt: string } & (
    | { readonly kind: "option"; readonly optionId: string; readonly label: string }
    | { readonly kind: "text"; readonly text: string }
  ))[];
  readonly delivery: {
    readonly status: "pending" | "claimed" | "applied" | "failed" | "obsolete";
    readonly revision: number;
    readonly updatedAt: string;
  };
}
export interface CanonicalUserInputUnavailable {
  readonly availability: "unavailable";
  readonly itemId: string;
  readonly kind: "user_input_request" | "user_input_answer";
}
export type CanonicalUserInput = CanonicalUserInputRequest | CanonicalUserInputAnswer | CanonicalUserInputUnavailable;
export interface CanonicalUserInputSnapshot<T extends CanonicalConversationItem = CanonicalConversationItem> {
  readonly items: readonly T[];
  readonly userInputs?: readonly CanonicalUserInput[];
}
type Scope = { readonly workspaceId: string; readonly threadId: string; readonly participantId?: string };
type Entry<T> = { readonly anchor?: T; readonly value: CanonicalUserInput };

/**
 * Reconcile only question/answer anchors; other history stays with its existing
 * merger. Full reads withdraw known omitted anchors; pages cannot do that.
 * Missing hydration is partial data, never a deletion or a grant.
 *
 * An unanchored unavailable DTO is a local, content-free replay tombstone. It
 * must never render as a placeholder or be sent back to the Host. Neither a
 * greater status revision nor a later arrival can undo it. Recovery requires
 * a new scoped read epoch after invalidating outstanding reads, not this merge.
 * The caller MUST reject old read epochs, including responses with unseen IDs.
 */
export function reconcileCanonicalUserInputs<T extends CanonicalConversationItem>(input: {
  readonly scope: Scope;
  readonly current?: CanonicalUserInputSnapshot<T>;
  readonly incoming: CanonicalUserInputSnapshot<T>;
  readonly mode: "full" | "page" | { readonly fromSequence: number; readonly beforeSequence?: number };
}): { readonly items: readonly T[]; readonly userInputs: readonly CanonicalUserInput[] } {
  const current = normalize(input.scope, input.current, true);
  const incoming = normalize(input.scope, input.incoming, false);
  const covered = (anchor: T | undefined): boolean => input.incoming.userInputs !== undefined && (input.mode === "full"
    || (typeof input.mode === "object" && !!anchor && anchor.sequence >= input.mode.fromSequence
      && (input.mode.beforeSequence === undefined || anchor.sequence < input.mode.beforeSequence)));
  const output = new Map<string, Entry<T>>();
  for (const [id, previous] of current) {
    const next = incoming.get(id);
    if (!next) {
      output.set(id, covered(previous.anchor) ? { value: unavailable(previous.value) } : previous);
    } else if (!previous.anchor) {
      // A Host omission already removed this anchor. An old snapshot cannot restore it.
      output.set(id, { value: unavailable(previous.value) });
    } else {
      const value = sameAnchorBinding(previous.anchor, next.anchor)
        ? mergeValue(previous.value, next.value) : unavailable(previous.value);
      const anchor = next.anchor && next.anchor.revision > previous.anchor.revision ? next.anchor : previous.anchor;
      output.set(id, { anchor, value });
    }
  }
  for (const [id, next] of incoming) if (!output.has(id)) output.set(id, next);
  const entries = [...output.values()].sort((a, b) =>
    (a.anchor?.sequence ?? Infinity) - (b.anchor?.sequence ?? Infinity));
  return {
    items: entries.flatMap(entry => entry.anchor ? [entry.anchor] : []),
    userInputs: entries.map(entry => entry.value),
  };
}

/** All per-record revisions matter, even when another record has a larger revision. */
export function userInputTranscriptRevisionSignature(items: readonly CanonicalUserInput[] | undefined): string {
  return JSON.stringify((items ?? []).map(item => item.availability === "unavailable"
    ? [item.itemId, item.kind, item.availability]
    : [item.itemId, item.kind, item.requestVersion, item.kind === "user_input_request"
      ? [item.statusRevision, item.status] : [item.answerId, item.delivery.revision, item.delivery.status]])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function normalize<T extends CanonicalConversationItem>(scope: Scope, snapshot: CanonicalUserInputSnapshot<T> | undefined, keepTombstones: boolean): Map<string, Entry<T>> {
  const entries = new Map<string, Entry<T>>();
  if (!snapshot?.userInputs) return entries;
  const anchors = new Map<string, T>();
  const conflicts = new Set<string>();
  for (const item of snapshot.items) {
    if (!isUserInputAnchor(item) || item.workspaceId !== scope.workspaceId || item.threadId !== scope.threadId) continue;
    const previous = anchors.get(item.id);
    if (previous && (!sameAnchorBinding(previous, item)
      || (previous.revision === item.revision && serialize(previous) !== serialize(item)))) conflicts.add(item.id);
    if (!previous || previous.revision < item.revision) anchors.set(item.id, item);
  }
  for (const record of snapshot.userInputs) {
    const anchor = anchors.get(record.itemId);
    if (!anchor) {
      if (keepTombstones && record.availability === "unavailable") entries.set(record.itemId, { value: unavailable(record) });
      continue;
    }
    const value = conflicts.has(record.itemId) ? unavailable(record) : selectPublicValue(scope, anchor, record);
    const previous = entries.get(record.itemId);
    entries.set(record.itemId, { anchor, value: previous ? mergeValue(previous.value, value) : value });
  }
  // A present hydration collection must explain every visible anchor. Never fill
  // missing content from a similarly named request or from stale cached prose.
  for (const [id, anchor] of anchors) if (!entries.has(id)) entries.set(id, {
    anchor, value: { availability: "unavailable", itemId: id, kind: anchor.kind as CanonicalUserInputUnavailable["kind"] },
  });
  return entries;
}

export function isUserInputAnchor(item: CanonicalConversationItem): boolean {
  return item.kind === "user_input_request" || item.kind === "user_input_answer";
}
function sameAnchorBinding(left: CanonicalConversationItem, right: CanonicalConversationItem | undefined): boolean {
  return Boolean(right && left.id === right.id && left.workspaceId === right.workspaceId && left.threadId === right.threadId
    && left.turnId === right.turnId && left.sequence === right.sequence && left.kind === right.kind
    && left.actorType === right.actorType && left.actorId === right.actorId && serialize(left.payload) === serialize(right.payload));
}
function unavailable(item: Pick<CanonicalUserInput, "itemId" | "kind">): CanonicalUserInputUnavailable {
  return { availability: "unavailable", itemId: item.itemId, kind: item.kind };
}
function selectPublicValue(scope: Scope, anchor: CanonicalConversationItem, item: CanonicalUserInput): CanonicalUserInput {
  if (item.availability === "unavailable") return unavailable({ ...item, kind: anchor.kind as CanonicalUserInputUnavailable["kind"] });
  const payload = anchor.payload as { requestId?: string; requestVersion?: number; answerId?: string; runEventPosition?: unknown } | null;
  const source = item.source;
  if (item.kind !== anchor.kind || anchor.status !== "committed" || !source || !payload
    || source.workspaceId !== scope.workspaceId || source.threadId !== scope.threadId || source.turnId !== anchor.turnId
    || (scope.participantId !== undefined && source.participantId !== scope.participantId)
    || (source.workflowStepId !== undefined && !nonempty(source.workflowStepId))
    || (item.kind === "user_input_request" && (anchor.actorId !== source.participantId
      || anchor.actorType !== (source.participantId === "ling_agent" ? "ling_agent" : "teammate")))
    || (item.kind === "user_input_answer" && anchor.actorType !== "local_user")
    || payload.requestId !== item.requestId || payload.requestVersion !== item.requestVersion || !positive(item.requestVersion)
    || ![source.turnId, source.runId, source.attemptId, source.workUnitId, source.participantId, source.sourceItemId, item.requestId].every(nonempty)
    || (item.kind === "user_input_answer" && payload.answerId !== item.answerId)) return unavailable(item);
  const position = item.runEventPosition;
  if (serialize(position) !== serialize(payload.runEventPosition)
    || (position !== undefined && (!isCanonicalUserInputRunEventPosition(position)
      || position.runId !== source.runId || position.attemptId !== source.attemptId))) return unavailable(item);
  const base = {
    availability: "available" as const, itemId: item.itemId, requestId: item.requestId, requestVersion: item.requestVersion,
    ...(position ? { runEventPosition: { runId: position.runId, attemptId: position.attemptId,
      afterEventSequence: position.afterEventSequence, ...(position.afterEventId ? { afterEventId: position.afterEventId } : {}) } } : {}),
    source: { workspaceId: source.workspaceId, threadId: source.threadId, turnId: source.turnId,
      runId: source.runId, attemptId: source.attemptId, workUnitId: source.workUnitId,
      participantId: source.participantId, sourceItemId: source.sourceItemId,
      ...(source.workflowStepId ? { workflowStepId: source.workflowStepId } : {}) },
  };
  if (item.kind === "user_input_request") {
    if (!positive(item.statusRevision) || !["pending", "answered", "skipped", "cancelled", "expired", "superseded"].includes(item.status)
      || !["optional", "required"].includes(item.waitMode) || !Array.isArray(item.questions)
      || !item.questions.every((q: CanonicalUserInputRequest["questions"][number]) => q && nonempty(q.questionId) && typeof q.prompt === "string"
        && typeof q.required === "boolean" && typeof q.allowFreeText === "boolean" && Array.isArray(q.options)
        && q.options.every(o => o && nonempty(o.optionId) && typeof o.label === "string"))) return unavailable(item);
    return { ...base, kind: item.kind, status: item.status, statusRevision: item.statusRevision, waitMode: item.waitMode,
      questions: item.questions.map((q: CanonicalUserInputRequest["questions"][number]) => ({ questionId: q.questionId, prompt: q.prompt, required: q.required,
        allowFreeText: q.allowFreeText, options: q.options.map(o => ({ optionId: o.optionId, label: o.label })) })),
      createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}) };
  }
  if (!item.delivery || !positive(item.delivery.revision) || !nonempty(item.answerId)
    || !["pending", "claimed", "applied", "failed", "obsolete"].includes(item.delivery.status)
    || !Array.isArray(item.answers) || !item.answers.every(a => a && nonempty(a.questionId) && typeof a.prompt === "string"
      && (a.kind === "text" ? typeof a.text === "string" : a.kind === "option" && nonempty(a.optionId) && typeof a.label === "string"))) return unavailable(item);
  return { ...base, kind: item.kind, answerId: item.answerId, acceptedAt: item.acceptedAt,
    answers: item.answers.map(a => ({ questionId: a.questionId, prompt: a.prompt, ...(a.kind === "text"
      ? { kind: a.kind, text: a.text } : { kind: a.kind, optionId: a.optionId, label: a.label }) })),
    delivery: { status: item.delivery.status, revision: item.delivery.revision, updatedAt: item.delivery.updatedAt } };
}
function mergeValue(left: CanonicalUserInput, right: CanonicalUserInput): CanonicalUserInput {
  if (left.availability === "unavailable" || right.availability === "unavailable" || left.kind !== right.kind) return unavailable(left);
  if (serialize(immutableContent(left)) !== serialize(immutableContent(right))) return unavailable(left);
  const a = revision(left), b = revision(right);
  if (a === b) return serialize(left) === serialize(right) ? left : unavailable(left);
  return a > b ? left : right;
}
function immutableContent(item: CanonicalUserInputRequest | CanonicalUserInputAnswer): unknown {
  if (item.kind === "user_input_request") {
    const { status: _status, statusRevision: _revision, updatedAt: _time, ...immutable } = item;
    return immutable;
  }
  const { delivery: _delivery, ...immutable } = item;
  return immutable;
}
function revision(item: CanonicalUserInputRequest | CanonicalUserInputAnswer): number {
  return item.kind === "user_input_request" ? item.statusRevision : item.delivery.revision;
}
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
/** Same bounded public shape as contracts, without a runtime dependency on the Host package. */
export function isCanonicalUserInputRunEventPosition(value: unknown): value is CanonicalUserInputRunEventPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const text = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0 && v.length <= 256;
  return Object.keys(row).every(key => ["runId", "attemptId", "afterEventSequence", "afterEventId"].includes(key))
    && text(row.runId) && text(row.attemptId) && typeof row.afterEventSequence === "number"
    && Number.isSafeInteger(row.afterEventSequence) && row.afterEventSequence >= 0
    && (row.afterEventSequence === 0 ? row.afterEventId === undefined : text(row.afterEventId));
}
function nonempty(value: string): boolean { return typeof value === "string" && value.trim().length > 0; }
function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(",")}}`;
}
