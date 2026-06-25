export type ConversationDisclosureKind = "block" | "span";

export interface ConversationDisclosureState {
  readonly expanded: boolean;
  readonly revisionKey: string;
  readonly touched: boolean;
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

export function createConversationViewStore(surfaceId: string): ConversationViewStore {
  return new ConversationViewStoreImpl(surfaceId);
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

  constructor(surfaceId: string) {
    this.surfaceId = surfaceId;
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
    next.set(input.id, {
      expanded: input.defaultExpanded,
      revisionKey: input.revisionKey,
      touched: false,
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
    if (current?.expanded === nextState.expanded && current.touched) {
      return;
    }
    const next = new Map(map);
    next.set(id, nextState);
    this.replaceDisclosureMap(kind, next);
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
