import { useRef } from "react";

export interface TeammateAsyncRequestToken<Action extends string> {
  readonly action: Action;
  readonly generation: number;
  readonly teammateId: string;
}

export interface TeammateAsyncRequestOwner<Action extends string> {
  readonly begin: (action: Action) => TeammateAsyncRequestToken<Action>;
  readonly isCurrent: (token: TeammateAsyncRequestToken<Action>) => boolean;
}

export function useTeammateAsyncRequestOwner<Action extends string>(
  teammateId: string,
): TeammateAsyncRequestOwner<Action> {
  const ownerRef = useRef<{
    teammateId: string;
    generations: Map<Action, number>;
  }>({ teammateId, generations: new Map() });

  if (ownerRef.current.teammateId !== teammateId) {
    ownerRef.current = { teammateId, generations: new Map() };
  }

  return {
    begin(action) {
      const owner = ownerRef.current;
      if (owner.teammateId !== teammateId) {
        return { action, generation: 0, teammateId };
      }
      const generation = (owner.generations.get(action) ?? 0) + 1;
      owner.generations.set(action, generation);
      return { action, generation, teammateId };
    },
    isCurrent(token) {
      const owner = ownerRef.current;
      return owner.teammateId === token.teammateId &&
        owner.generations.get(token.action) === token.generation;
    },
  };
}
