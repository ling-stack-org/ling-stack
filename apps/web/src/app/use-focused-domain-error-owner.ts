import { useEffect, useReducer, useRef } from "react";
import type { DomainError } from "./domain-controller.js";

export interface FocusedDomainError<
  TDomain extends string = string,
  TAction extends string = string,
> extends DomainError {
  readonly domain: TDomain;
  readonly identity: string;
  readonly objectId: string;
  readonly action: TAction;
  readonly requestId: number;
}

export interface FocusedErrorRequest<
  TDomain extends string = string,
  TAction extends string = string,
> {
  readonly domain: TDomain;
  readonly identity: string;
  readonly objectId: string;
  readonly action: TAction;
  readonly requestId: number;
  readonly ownerKey: string;
}

export interface FocusedDomainErrorOwner<
  TDomain extends string = string,
  TAction extends string = string,
> {
  readonly identity: () => string;
  readonly setIdentity: (identity: string) => void;
  readonly begin: (domain: TDomain, objectId: string, action: TAction) => FocusedErrorRequest<TDomain, TAction>;
  readonly isCurrent: (request: FocusedErrorRequest<TDomain, TAction>) => boolean;
  readonly clear: (request: FocusedErrorRequest<TDomain, TAction>) => boolean;
  readonly report: (
    request: FocusedErrorRequest<TDomain, TAction>,
    error: Pick<DomainError, "scope" | "message" | "retryLabel">,
  ) => boolean;
  readonly reportImmediate: (
    domain: TDomain,
    objectId: string,
    action: TAction,
    error: Pick<DomainError, "scope" | "message" | "retryLabel">,
  ) => FocusedErrorRequest<TDomain, TAction>;
  readonly invalidateRequests: () => void;
  readonly clearAll: () => void;
  readonly errors: () => readonly FocusedDomainError<TDomain, TAction>[];
  readonly latest: () => FocusedDomainError<TDomain, TAction> | undefined;
}

export function createFocusedDomainErrorOwner<
  TDomain extends string = string,
  TAction extends string = string,
>(
  initialIdentity: string,
  onErrorsChanged: () => void = () => undefined,
): FocusedDomainErrorOwner<TDomain, TAction> {
  let currentIdentity = initialIdentity;
  let requestSequence = 0;
  let reportSequence = 0;
  const currentRequests = new Map<string, number>();
  const errorsByOwner = new Map<string, {
    readonly error: FocusedDomainError<TDomain, TAction>;
    readonly order: number;
  }>();

  function ownerKey(domain: TDomain, objectId: string, action: TAction): string {
    return JSON.stringify([domain, objectId, action]);
  }

  function isCurrent(request: FocusedErrorRequest<TDomain, TAction>): boolean {
    return request.identity === currentIdentity
      && currentRequests.get(request.ownerKey) === request.requestId;
  }

  function errors(): readonly FocusedDomainError<TDomain, TAction>[] {
    return [...errorsByOwner.values()]
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.error);
  }

  const owner: FocusedDomainErrorOwner<TDomain, TAction> = {
    identity: () => currentIdentity,
    setIdentity: (identity) => {
      if (identity === currentIdentity) return;
      currentIdentity = identity;
      currentRequests.clear();
      errorsByOwner.clear();
    },
    begin: (domain, objectId, action) => {
      const key = ownerKey(domain, objectId, action);
      const requestId = ++requestSequence;
      currentRequests.set(key, requestId);
      return {
        domain,
        identity: currentIdentity,
        objectId,
        action,
        requestId,
        ownerKey: key,
      };
    },
    isCurrent,
    clear: (request) => {
      if (!isCurrent(request) || !errorsByOwner.delete(request.ownerKey)) return false;
      onErrorsChanged();
      return true;
    },
    report: (request, error) => {
      if (!isCurrent(request)) return false;
      errorsByOwner.set(request.ownerKey, {
        error: {
          action: request.action,
          domain: request.domain,
          identity: request.identity,
          message: error.message,
          objectId: request.objectId,
          requestId: request.requestId,
          retryLabel: error.retryLabel,
          scope: error.scope,
        },
        order: ++reportSequence,
      });
      onErrorsChanged();
      return true;
    },
    reportImmediate: (domain, objectId, action, error) => {
      const request = owner.begin(domain, objectId, action);
      owner.report(request, error);
      return request;
    },
    invalidateRequests: () => {
      currentRequests.clear();
    },
    clearAll: () => {
      currentRequests.clear();
      if (errorsByOwner.size === 0) return;
      errorsByOwner.clear();
      onErrorsChanged();
    },
    errors,
    latest: () => errors().at(-1),
  };
  return owner;
}

export function useFocusedDomainErrorOwner<
  TDomain extends string = string,
  TAction extends string = string,
>(identity: string): FocusedDomainErrorOwner<TDomain, TAction> {
  const mountedRef = useRef(true);
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const ownerRef = useRef<FocusedDomainErrorOwner<TDomain, TAction>>();
  if (!ownerRef.current) {
    ownerRef.current = createFocusedDomainErrorOwner<TDomain, TAction>(identity, () => {
      if (mountedRef.current) rerender();
    });
  }
  ownerRef.current.setIdentity(identity);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ownerRef.current?.invalidateRequests();
    };
  }, []);

  return ownerRef.current;
}

export function domainErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
