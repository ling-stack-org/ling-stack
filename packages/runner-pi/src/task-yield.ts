import type { PiRunnerUserInputYieldDirective } from "./types.js";

/** Typed control outcome, never task success or an OS/remote-job stop receipt. */
export class PiRunnerYielded extends Error {
  readonly request: PiRunnerUserInputYieldDirective;
  constructor(request: PiRunnerUserInputYieldDirective, readonly sdkStoppedAt: string) {
    super("Runner yielded for required user input.");
    this.name = "PiRunnerYielded";
    this.request = readUserInputYieldDirective(request);
  }
}

/** Copy only the closed Host directive. Do not retain a mutable callback object. */
export function readUserInputYieldDirective(value: unknown): PiRunnerUserInputYieldDirective {
  const reject = (): never => { throw new Error("Invalid user input yield directive."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  const keys = Reflect.ownKeys(value);
  const names = ["kind", "requestId", "requestVersion"];
  if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key))) return reject();
  const fields = names.map((name) => Object.getOwnPropertyDescriptor(value, name));
  if (fields.some((field) => !field || !("value" in field))) return reject();
  const [kind, requestId, requestVersion] = fields.map((field) => field!.value);
  if (kind !== "user_input_required" || typeof requestId !== "string"
    || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(requestId) || !Number.isSafeInteger(requestVersion) || requestVersion < 1) return reject();
  return Object.freeze({ kind, requestId, requestVersion });
}
