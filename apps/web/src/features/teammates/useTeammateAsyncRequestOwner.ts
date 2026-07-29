import { useReducer, useRef } from "react";

export interface TeammateAsyncRequestToken<Action extends string, Resource extends string = never> {
  readonly action: Action;
  readonly actionGeneration: number;
  readonly identity: string;
  readonly identityRevision: number;
  readonly resourceRevisions: ReadonlyMap<Resource, number>;
  readonly teammateId: string;
}

export interface TeammateActionError<Action extends string> {
  readonly action: Action;
  readonly actionGeneration: number;
  readonly identity: string;
  readonly message: string;
  readonly order: number;
}

export interface TeammateAsyncRequestOwner<Action extends string, Resource extends string = never> {
  readonly latestError?: TeammateActionError<Action>;
  readonly begin: (
    action: Action,
    resources?: readonly Resource[],
  ) => TeammateAsyncRequestToken<Action, Resource>;
  readonly claimAndCommit: (
    token: TeammateAsyncRequestToken<Action, Resource>,
    resources: readonly Resource[],
    apply: () => void,
  ) => boolean;
  readonly clearActionError: (action: Action) => void;
  readonly clearError: (token: TeammateAsyncRequestToken<Action, Resource>) => boolean;
  readonly commit: (
    token: TeammateAsyncRequestToken<Action, Resource>,
    resource: Resource,
    apply: () => void,
  ) => boolean;
  readonly isActionCurrent: (token: TeammateAsyncRequestToken<Action, Resource>) => boolean;
  readonly ownsResource: (
    token: TeammateAsyncRequestToken<Action, Resource>,
    resource: Resource,
  ) => boolean;
  readonly reportError: (
    token: TeammateAsyncRequestToken<Action, Resource>,
    message: string,
  ) => boolean;
  readonly reportImmediate: (action: Action, message: string) => void;
}

export class TeammateAsyncRequestStore<Action extends string, Resource extends string = never> {
  private currentIdentity: string;
  private currentTeammateId: string;
  private identityRevision = 1;
  private errorOrder = 0;
  private resourceSequence = 0;
  private readonly actionGenerations = new Map<Action, number>();
  private readonly resourceRevisions = new Map<Resource, number>();
  private readonly errorsByOwner = new Map<string, TeammateActionError<Action>>();

  constructor(
    identity: string,
    teammateId: string,
    private readonly onErrorsChanged: () => void = () => undefined,
  ) {
    this.currentIdentity = identity;
    this.currentTeammateId = teammateId;
  }

  setIdentity(identity: string, teammateId: string): void {
    if (identity === this.currentIdentity && teammateId === this.currentTeammateId) return;
    this.currentIdentity = identity;
    this.currentTeammateId = teammateId;
    this.identityRevision += 1;
    this.actionGenerations.clear();
    this.resourceRevisions.clear();
  }

  beginFor(
    identity: string,
    teammateId: string,
    action: Action,
    resources: readonly Resource[] = [],
  ): TeammateAsyncRequestToken<Action, Resource> {
    if (identity !== this.currentIdentity || teammateId !== this.currentTeammateId) {
      return {
        action,
        actionGeneration: 0,
        identity,
        identityRevision: -1,
        resourceRevisions: new Map(),
        teammateId,
      };
    }
    const actionGeneration = (this.actionGenerations.get(action) ?? 0) + 1;
    this.actionGenerations.set(action, actionGeneration);
    const ownedResources = new Map<Resource, number>();
    for (const resource of new Set(resources)) {
      const revision = ++this.resourceSequence;
      this.resourceRevisions.set(resource, revision);
      ownedResources.set(resource, revision);
    }
    return {
      action,
      actionGeneration,
      identity,
      identityRevision: this.identityRevision,
      resourceRevisions: ownedResources,
      teammateId,
    };
  }

  isActionCurrent(token: TeammateAsyncRequestToken<Action, Resource>): boolean {
    return token.identity === this.currentIdentity
      && token.teammateId === this.currentTeammateId
      && token.identityRevision === this.identityRevision
      && this.actionGenerations.get(token.action) === token.actionGeneration;
  }

  ownsResource(token: TeammateAsyncRequestToken<Action, Resource>, resource: Resource): boolean {
    return this.isActionCurrent(token)
      && token.resourceRevisions.get(resource) === this.resourceRevisions.get(resource);
  }

  commit(
    token: TeammateAsyncRequestToken<Action, Resource>,
    resource: Resource,
    apply: () => void,
  ): boolean {
    if (!this.ownsResource(token, resource)) return false;
    apply();
    return true;
  }

  claimAndCommit(
    token: TeammateAsyncRequestToken<Action, Resource>,
    resources: readonly Resource[],
    apply: () => void,
  ): boolean {
    if (!this.isActionCurrent(token)) return false;
    const ownedResources = token.resourceRevisions as Map<Resource, number>;
    for (const resource of new Set(resources)) {
      const revision = ++this.resourceSequence;
      this.resourceRevisions.set(resource, revision);
      ownedResources.set(resource, revision);
    }
    apply();
    return true;
  }

  reportError(token: TeammateAsyncRequestToken<Action, Resource>, message: string): boolean {
    if (!this.isActionCurrent(token)) return false;
    const normalizedMessage = message.trim();
    if (!normalizedMessage) return this.clearError(token);
    const key = errorKey(token.identity, token.action);
    const current = this.errorsByOwner.get(key);
    if (
      current?.message === normalizedMessage
      && current.actionGeneration === token.actionGeneration
    ) return false;
    this.errorsByOwner.set(key, {
      action: token.action,
      actionGeneration: token.actionGeneration,
      identity: token.identity,
      message: normalizedMessage,
      order: ++this.errorOrder,
    });
    this.onErrorsChanged();
    return true;
  }

  clearError(token: TeammateAsyncRequestToken<Action, Resource>): boolean {
    if (!this.isActionCurrent(token)) return false;
    const changed = this.errorsByOwner.delete(errorKey(token.identity, token.action));
    if (changed) this.onErrorsChanged();
    return changed;
  }

  latestError(identity = this.currentIdentity): TeammateActionError<Action> | undefined {
    return [...this.errorsByOwner.values()]
      .filter((entry) => entry.identity === identity)
      .sort((left, right) => left.order - right.order)
      .at(-1);
  }
}

export function useTeammateAsyncRequestOwner<Action extends string, Resource extends string = never>(
  teammateId: string,
  identity = teammateId,
): TeammateAsyncRequestOwner<Action, Resource> {
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const storeRef = useRef<TeammateAsyncRequestStore<Action, Resource>>();
  if (!storeRef.current) {
    storeRef.current = new TeammateAsyncRequestStore<Action, Resource>(identity, teammateId, rerender);
  }
  const store = storeRef.current;
  store.setIdentity(identity, teammateId);

  const begin = (
    action: Action,
    resources: readonly Resource[] = [],
  ): TeammateAsyncRequestToken<Action, Resource> => store.beginFor(identity, teammateId, action, resources);

  return {
    latestError: store.latestError(identity),
    begin,
    claimAndCommit: (token, resources, apply) => store.claimAndCommit(token, resources, apply),
    clearActionError: (action) => {
      store.clearError(begin(action));
    },
    clearError: (token) => store.clearError(token),
    commit: (token, resource, apply) => store.commit(token, resource, apply),
    isActionCurrent: (token) => store.isActionCurrent(token),
    ownsResource: (token, resource) => store.ownsResource(token, resource),
    reportError: (token, message) => store.reportError(token, message),
    reportImmediate: (action, message) => {
      store.reportError(begin(action), message);
    },
  };
}

function errorKey<Action extends string>(identity: string, action: Action): string {
  return JSON.stringify([identity, action]);
}
