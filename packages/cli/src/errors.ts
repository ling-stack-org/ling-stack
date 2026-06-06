export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly status?: number;

  constructor(exitCode: number, code: string, message: string, status?: number) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
