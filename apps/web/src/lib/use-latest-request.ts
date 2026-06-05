import { useRef } from "react";

export interface LatestRequestGuard {
  readonly next: () => number;
  readonly isCurrent: (token: number) => boolean;
}

export function useLatestRequestGuard(): LatestRequestGuard {
  const tokenRef = useRef(0);
  return {
    next(): number {
      tokenRef.current += 1;
      return tokenRef.current;
    },
    isCurrent(token: number): boolean {
      return token === tokenRef.current;
    },
  };
}

export interface LatestKeyedRequestGuard {
  readonly next: (key: string) => number;
  readonly isCurrent: (key: string, token: number) => boolean;
  readonly reset: (key?: string) => void;
}

export function useLatestKeyedRequestGuard(): LatestKeyedRequestGuard {
  const tokenByKeyRef = useRef(new Map<string, number>());
  return {
    next(key: string): number {
      const nextToken = (tokenByKeyRef.current.get(key) ?? 0) + 1;
      tokenByKeyRef.current.set(key, nextToken);
      return nextToken;
    },
    isCurrent(key: string, token: number): boolean {
      return tokenByKeyRef.current.get(key) === token;
    },
    reset(key?: string): void {
      if (key) {
        tokenByKeyRef.current.delete(key);
        return;
      }
      tokenByKeyRef.current.clear();
    },
  };
}
