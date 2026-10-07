import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXECUTION_TIERS = new Set(["complete", "preview", "ignore"]);
const SCOPE_MODES = new Set(["docs", "affected", "full"]);
const LANES = ["SCOPE", "COMMON", "DEPENDENCY", "BUILD", "TYPECHECK", "UNIT", "DAEMON"];
const PRODUCT_LANES = ["DEPENDENCY", "BUILD", "TYPECHECK", "UNIT"];
const DAEMON_LANES = ["DAEMON"];
const JOB_RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);

/**
 * Keep Draft development inexpensive without publishing an incomplete merge gate.
 * A full-ci label opts a Draft into the same complete checks as a ready PR.
 * Unrelated label events must not replace a previous required check on the head.
 * @param {{eventName: string, event: object}} input GitHub event name and payload.
 * @returns {"complete"|"preview"|"ignore"}
 * @throws {Error} When a pull-request payload cannot be interpreted safely.
 */
export function selectExecutionTier({ eventName, event }) {
  requireNonemptyString(eventName, "eventName");
  if (eventName !== "pull_request") return "complete";
  requireObject(event, "event");
  requireNonemptyString(event.action, "event.action");
  requireObject(event.pull_request, "event.pull_request");
  if (typeof event.pull_request.draft !== "boolean") {
    throw new Error("event.pull_request.draft must be a boolean");
  }
  if (!Array.isArray(event.pull_request.labels)) {
    throw new Error("event.pull_request.labels must be an array");
  }
  const labels = event.pull_request.labels.map((label) => {
    requireObject(label, "pull request label");
    requireNonemptyString(label.name, "pull request label.name");
    return label.name.toLowerCase();
  });
  if (event.action === "labeled") {
    requireObject(event.label, "event.label");
    requireNonemptyString(event.label.name, "event.label.name");
    if (event.label.name.toLowerCase() === "full-ci") {
      if (!labels.includes("full-ci")) throw new Error("full-ci label event is inconsistent with pull request labels");
      return "complete";
    }
    return "ignore";
  }
  if (event.action === "unlabeled") return "ignore";
  return event.pull_request.draft && !labels.includes("full-ci") ? "preview" : "complete";
}

/**
 * Fail closed if any selected lane did not execute successfully. Even a lane
 * outside the scope cannot hide a failure or cancellation behind the aggregate.
 * A Draft preview always fails the merge gate after its common checks pass.
 * @param {{tier: "complete"|"preview"|"ignore", mode: "docs"|"affected"|"full", daemon: boolean, results: Record<string, string>}} input
 * @returns {true} Only a complete execution with all required lanes succeeding.
 * @throws {Error} For malformed scope, failed lanes, or intentionally deferred CI.
 */
export function assertCiResults({ tier, mode, daemon, results }) {
  if (!EXECUTION_TIERS.has(tier)) throw new Error(`Invalid EXECUTION_TIER: ${String(tier)}`);
  if (tier === "ignore") throw new Error("ignored_event_not_quality_gate: unrelated label events cannot publish the required CI context");
  if (!SCOPE_MODES.has(mode)) throw new Error(`Invalid SCOPE_MODE: ${String(mode)}`);
  if (typeof daemon !== "boolean") throw new Error("DAEMON_SELECTED must be true or false");
  requireObject(results, "results");

  const required = new Set(["SCOPE", "COMMON"]);
  if (tier === "complete") {
    if (mode !== "docs") for (const lane of PRODUCT_LANES) required.add(lane);
    if (daemon) for (const lane of DAEMON_LANES) required.add(lane);
  }

  const failures = LANES.filter((lane) => {
    const result = results[lane];
    return !JOB_RESULTS.has(result)
      || result === "failure"
      || result === "cancelled"
      || (required.has(lane) && result !== "success");
  });
  if (failures.length > 0) {
    throw new Error(`CI lanes failed: ${failures.map((lane) => `${lane}=${results[lane] ?? ""}`).join(" ")}`);
  }
  if (tier === "preview") {
    throw new Error("deferred_by_draft_policy: common checks passed; product checks are deferred until ready_for_review or full-ci");
  }
  return true;
}

/** @param {unknown} value @param {string} name */
function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

/** @param {unknown} value @param {string} name */
function requireNonemptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a nonempty string`);
}

/** @param {string[]} args */
function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const [name, ...valueParts] = argument.split("=");
    if (name === "--check-quality") {
      if (valueParts.length > 0 || options.checkQuality) throw new Error("--check-quality must appear once without a value");
      options.checkQuality = true;
      continue;
    }
    if (name !== "--event-file" && name !== "--event-name") throw new Error(`Unknown argument: ${argument}`);
    const key = name === "--event-file" ? "eventFile" : "eventName";
    if (options[key] !== undefined) throw new Error(`Duplicate argument: ${name}`);
    const value = valueParts.length > 0 ? valueParts.join("=") : args[++index];
    requireNonemptyString(value, name);
    if (value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    options[key] = value;
  }
  if (options.checkQuality && (options.eventFile !== undefined || options.eventName !== undefined)) {
    throw new Error("--check-quality cannot be combined with event arguments");
  }
  if (!options.checkQuality && options.eventFile === undefined) throw new Error("--event-file is required");
  return options;
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function main(args, env) {
  const options = parseArguments(args);
  if (options.checkQuality) {
    if (env.DAEMON_SELECTED !== "true" && env.DAEMON_SELECTED !== "false") {
      throw new Error("DAEMON_SELECTED must be true or false");
    }
    assertCiResults({
      tier: env.EXECUTION_TIER,
      mode: env.SCOPE_MODE,
      daemon: env.DAEMON_SELECTED === "true",
      results: Object.fromEntries(LANES.map((lane) => [lane, env[`${lane}_RESULT`]])),
    });
    console.log("All applicable CI lanes passed; skipped lanes were outside this change scope.");
    return;
  }
  const event = JSON.parse(readFileSync(options.eventFile, "utf8"));
  console.log(selectExecutionTier({ eventName: options.eventName ?? env.GITHUB_EVENT_NAME, event }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
