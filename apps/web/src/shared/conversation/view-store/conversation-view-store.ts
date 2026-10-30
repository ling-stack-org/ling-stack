export type ConversationDisclosureKind = "block" | "span";

export interface ConversationDisclosureState {
  readonly expanded: boolean;
  readonly revisionKey: string;
  readonly touched: boolean;
  /** Restored intent stays beneath live defaults until the user interacts here. */
  readonly restoredExpanded?: boolean;
}

export interface ConversationCopyFeedbackState {
  readonly copiedAt: number;
}

export interface ConversationViewState {
  readonly blockDisclosureById: ReadonlyMap<string, ConversationDisclosureState>;
  readonly spanDisclosureById: ReadonlyMap<string, ConversationDisclosureState>;
  readonly activeActionId: string | undefined;
  readonly copyFeedbackByActionId: ReadonlyMap<string, ConversationCopyFeedbackState>;
}

export interface ConversationViewRetainKeys {
  readonly blockIds: ReadonlySet<string>;
  readonly spanIds: ReadonlySet<string>;
  readonly actionIds: ReadonlySet<string>;
}

export interface ConversationDisclosureInput {
  readonly id: string;
  readonly kind: ConversationDisclosureKind;
  readonly revisionKey: string;
  readonly defaultExpanded: boolean;
  readonly preserveTouchedStateOnRevision?: boolean;
}

export interface ConversationViewStore {
  readonly surfaceId: string;
  getSnapshot(): ConversationViewState;
  subscribe(listener: () => void): () => void;
  ensureDisclosure(input: ConversationDisclosureInput): void;
  setDisclosureExpanded(kind: ConversationDisclosureKind, id: string, expanded: boolean): void;
  toggleDisclosure(kind: ConversationDisclosureKind, id: string): void;
  setActiveActionId(actionId: string | undefined): void;
  clearActiveActionId(actionId: string): void;
  markCopied(actionId: string, copiedAt?: number): number;
  clearCopyFeedback(actionId: string, copiedAt?: number): void;
  reconcileRetainedKeys(retainKeys: ConversationViewRetainKeys): void;
}

export interface ConversationDisclosurePersistence {
  read(kind: ConversationDisclosureKind, id: string): boolean | undefined;
  write(kind: ConversationDisclosureKind, id: string, expanded: boolean): void;
}

export function createConversationViewStore(surfaceId: string, persistence?: ConversationDisclosurePersistence): ConversationViewStore {
  return new ConversationViewStoreImpl(surfaceId, persistence);
}

class ConversationViewStoreImpl implements ConversationViewStore {
  readonly surfaceId: string;

  private state: ConversationViewState = {
    blockDisclosureById: new Map(),
    spanDisclosureById: new Map(),
    activeActionId: undefined,
    copyFeedbackByActionId: new Map(),
  };

  private readonly listeners = new Set<() => void>();
  private readonly persistence?: ConversationDisclosurePersistence;

  constructor(surfaceId: string, persistence?: ConversationDisclosurePersistence) {
    this.surfaceId = surfaceId;
    this.persistence = persistence;
  }

  getSnapshot(): ConversationViewState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ensureDisclosure(input: ConversationDisclosureInput): void {
    const map = this.mapForKind(input.kind);
    const current = map.get(input.id);
    if (current && current.revisionKey === input.revisionKey) {
      return;
    }
    const next = new Map(map);
    const saved = current ? current.restoredExpanded : this.persistence?.read(input.kind, input.id);
    next.set(input.id, {
      // A restored collapse cannot conceal a newly running/waiting/failed row.
      expanded: saved !== undefined ? input.defaultExpanded || saved : input.preserveTouchedStateOnRevision && current?.touched
        ? current.expanded
        : input.defaultExpanded,
      revisionKey: input.revisionKey,
      touched: saved !== undefined || (input.preserveTouchedStateOnRevision ? current?.touched ?? false : false),
      ...(saved !== undefined ? { restoredExpanded: saved } : {}),
    });
    this.replaceDisclosureMap(input.kind, next);
  }

  setDisclosureExpanded(kind: ConversationDisclosureKind, id: string, expanded: boolean): void {
    const map = this.mapForKind(kind);
    const current = map.get(id);
    const nextState: ConversationDisclosureState = {
      expanded,
      revisionKey: current?.revisionKey ?? "0",
      touched: true,
    };
    if (current?.expanded === nextState.expanded && current.touched && current.restoredExpanded === undefined) {
      return;
    }
    const next = new Map(map);
    next.set(id, nextState);
    this.replaceDisclosureMap(kind, next);
    this.persistence?.write(kind, id, expanded);
  }

  toggleDisclosure(kind: ConversationDisclosureKind, id: string): void {
    const current = this.mapForKind(kind).get(id);
    this.setDisclosureExpanded(kind, id, !(current?.expanded ?? false));
  }

  setActiveActionId(actionId: string | undefined): void {
    if (this.state.activeActionId === actionId) {
      return;
    }
    this.state = { ...this.state, activeActionId: actionId };
    this.emit();
  }

  clearActiveActionId(actionId: string): void {
    if (this.state.activeActionId !== actionId) {
      return;
    }
    this.setActiveActionId(undefined);
  }

  markCopied(actionId: string, copiedAt = Date.now()): number {
    const current = this.state.copyFeedbackByActionId.get(actionId);
    if (current?.copiedAt === copiedAt) {
      return copiedAt;
    }
    const next = new Map(this.state.copyFeedbackByActionId);
    next.set(actionId, { copiedAt });
    this.state = { ...this.state, copyFeedbackByActionId: next };
    this.emit();
    return copiedAt;
  }

  clearCopyFeedback(actionId: string, copiedAt?: number): void {
    const current = this.state.copyFeedbackByActionId.get(actionId);
    if (!current || (copiedAt !== undefined && current.copiedAt !== copiedAt)) {
      return;
    }
    const next = new Map(this.state.copyFeedbackByActionId);
    next.delete(actionId);
    this.state = { ...this.state, copyFeedbackByActionId: next };
    this.emit();
  }

  reconcileRetainedKeys(retainKeys: ConversationViewRetainKeys): void {
    const nextBlockDisclosureById = retainMapKeys(this.state.blockDisclosureById, retainKeys.blockIds);
    const nextSpanDisclosureById = retainMapKeys(this.state.spanDisclosureById, retainKeys.spanIds);
    const nextCopyFeedbackByActionId = retainMapKeys(this.state.copyFeedbackByActionId, retainKeys.actionIds);
    const nextActiveActionId = this.state.activeActionId && retainKeys.actionIds.has(this.state.activeActionId)
      ? this.state.activeActionId
      : undefined;
    if (
      nextBlockDisclosureById === this.state.blockDisclosureById &&
      nextSpanDisclosureById === this.state.spanDisclosureById &&
      nextCopyFeedbackByActionId === this.state.copyFeedbackByActionId &&
      nextActiveActionId === this.state.activeActionId
    ) {
      return;
    }
    this.state = {
      ...this.state,
      blockDisclosureById: nextBlockDisclosureById,
      spanDisclosureById: nextSpanDisclosureById,
      activeActionId: nextActiveActionId,
      copyFeedbackByActionId: nextCopyFeedbackByActionId,
    };
    this.emit();
  }

  private mapForKind(kind: ConversationDisclosureKind): ReadonlyMap<string, ConversationDisclosureState> {
    return kind === "block" ? this.state.blockDisclosureById : this.state.spanDisclosureById;
  }

  private replaceDisclosureMap(kind: ConversationDisclosureKind, map: ReadonlyMap<string, ConversationDisclosureState>): void {
    this.state = kind === "block"
      ? { ...this.state, blockDisclosureById: map }
      : { ...this.state, spanDisclosureById: map };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function retainMapKeys<TValue>(
  map: ReadonlyMap<string, TValue>,
  retainKeys: ReadonlySet<string>,
): ReadonlyMap<string, TValue> {
  if (map.size === 0) {
    return map;
  }
  let next: Map<string, TValue> | undefined;
  for (const key of map.keys()) {
    if (retainKeys.has(key)) {
      continue;
    }
    next ??= new Map(map);
    next.delete(key);
  }
  return next ?? map;
}
