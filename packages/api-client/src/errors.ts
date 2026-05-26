export class LingDaemonError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(message: string, status: number, statusText: string) {
    super(message);
    this.name = "LingDaemonError";
    this.status = status;
    this.statusText = statusText;
  }
}
