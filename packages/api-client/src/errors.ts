export class LingDaemonError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code?: string;

  constructor(message: string, status: number, statusText: string, code?: string) {
    super(message);
    this.name = "LingDaemonError";
    this.status = status;
    this.statusText = statusText;
    this.code = code;
  }
}

/** An observation failure at an IO boundary, not a Host/business rejection. */
export class LingDaemonTransportError extends Error {
  constructor(readonly phase: "fetch" | "stream-read", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "LingDaemonTransportError";
  }
}
