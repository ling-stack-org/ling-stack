export interface DomainError {
  readonly scope: "load" | "mutation" | "stream";
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly technicalMessage?: string;
  readonly origin?: "transport";
  readonly retryLabel?: string;
}

export interface DomainController<TState, TActions> {
  readonly state: TState;
  readonly actions: TActions;
  readonly refresh: () => Promise<void>;
  readonly isLoading: boolean;
  readonly error: DomainError | undefined;
  readonly clearError: () => void;
}
