import type { PiRunnerUserInputRequestReceipt } from "./types.js";
import { readUserInputYieldDirective } from "./task-yield.js";

/** Read just the control discriminator; the Core owns full question validation. */
export function readUserInputWaitMode(input: unknown): "required" | "optional" {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const mode = Object.getOwnPropertyDescriptor(input, "waitMode");
  if (!mode || !("value" in mode) || !["required", "optional"].includes(mode.value)) throw invalid();
  return mode.value;
}

/** Closed immutable receipt. Model or mutable callback fields never become authority. */
export function readUserInputRequestReceipt(value: unknown, mode: "required" | "optional"): PiRunnerUserInputRequestReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const names = ["kind", "requestId", "requestVersion"];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) throw invalid();
  const fields = names.map(name => Object.getOwnPropertyDescriptor(value, name));
  if (fields.some(field => !field || !("value" in field))) throw invalid();
  const [kind, requestId, requestVersion] = fields.map(field => field!.value);
  if (kind !== (mode === "required" ? "user_input_required" : "user_input_optional")) throw invalid();
  const identity = readUserInputYieldDirective({ kind: "user_input_required", requestId, requestVersion });
  return Object.freeze({ ...identity, kind });
}

function invalid(): Error { return new Error("Invalid user input request receipt or wait mode."); }
