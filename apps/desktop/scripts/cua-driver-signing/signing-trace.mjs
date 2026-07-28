import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SigningContractError, canonicalJson, sha256Bytes } from "./signing-contract.mjs";

const TRACE_FILE = "provider-signing-trace.json";
const STATE_FILE = "provider-signing-state.json";
const traceAppendQueues = new Map();

export function resolveSigningStateDirectory(input = {}) {
  if (typeof input.stateDirectory === "string" && input.stateDirectory.trim()) {
    return resolve(input.stateDirectory);
  }
  if (process.env.LING_CUA_SIGNING_EVIDENCE_DIR) {
    return resolve(process.env.LING_CUA_SIGNING_EVIDENCE_DIR);
  }
  if (typeof input.appOutDir !== "string" || input.appOutDir.trim() === "") {
    throw new SigningContractError(
      "signing_evidence_directory_missing",
      "appOutDir or stateDirectory is required for signing evidence",
    );
  }
  const resolvedOutput = resolve(input.appOutDir);
  const outputKey = sha256Bytes(resolvedOutput).slice(0, 12);
  return resolve(dirname(resolvedOutput), `.ling-cua-driver-signing-${outputKey}`);
}

export async function loadSigningTrace(stateDirectory) {
  const path = join(resolve(stateDirectory), TRACE_FILE);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed?.kind !== "ling-cua-driver-signing-feasibility-trace" ||
      !Array.isArray(parsed.events)
    ) {
      throw new Error("trace shape invalid");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw new SigningContractError("signing_trace_invalid", `Unable to parse ${path}`, { cause: error });
  }
}

export function appendSigningTrace(stateDirectory, event) {
  const directory = resolve(stateDirectory);
  const previous = traceAppendQueues.get(directory) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => appendSigningTraceSerially(directory, event));
  traceAppendQueues.set(directory, current);
  return current.finally(() => {
    if (traceAppendQueues.get(directory) === current) {
      traceAppendQueues.delete(directory);
    }
  });
}

async function appendSigningTraceSerially(directory, event) {
  const existing = await loadSigningTrace(directory);
  const events = existing?.events ?? [];
  const normalized = Object.freeze({
    sequence: events.length + 1,
    hook: String(event.hook),
    event: String(event.event),
    ...Object.fromEntries(
      Object.entries(event)
        .filter(([key, value]) => !["hook", "event"].includes(key) && value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
  const trace = {
    schemaVersion: 1,
    kind: "ling-cua-driver-signing-feasibility-trace",
    electronBuilderVersion: "26.15.3",
    events: [...events, normalized],
  };
  await writeJsonAtomically(join(directory, TRACE_FILE), trace);
  return Object.freeze(normalized);
}

export async function writeSigningState(stateDirectory, state, options = {}) {
  const directory = resolve(stateDirectory);
  const path = join(directory, STATE_FILE);
  if (options.exclusive) {
    try {
      await readFile(path);
      throw new SigningContractError(
        "provider_signing_state_already_exists",
        `Refusing to replace sealed provider state at ${path}`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  await writeJsonAtomically(path, {
    schemaVersion: 1,
    kind: "ling-cua-driver-signing-feasibility-state",
    ...state,
  });
  return path;
}

export async function readSigningState(stateDirectory, options = {}) {
  const path = join(resolve(stateDirectory), STATE_FILE);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed?.kind !== "ling-cua-driver-signing-feasibility-state"
    ) {
      throw new Error("state shape invalid");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT" && options.optional) {
      return undefined;
    }
    throw new SigningContractError("provider_signing_state_invalid", `Unable to parse ${path}`, {
      cause: error,
    });
  }
}

export function signingStateFingerprint(state) {
  return sha256Bytes(canonicalJson(state));
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: "wx" });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
