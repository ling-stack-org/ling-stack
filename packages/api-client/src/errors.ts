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
