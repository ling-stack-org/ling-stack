import type { DatabaseSync } from "node:sqlite";
import { readSqliteWithinTransaction } from "./read-snapshot.js";

/** Pure synchronous denial gate inside the journal-owned writer lock, before any launch latch. */
export function assertHostLaunchPreflight(database: DatabaseSync, assertMayLaunch?: () => void): void {
  if (assertMayLaunch === undefined) return;
  if (typeof assertMayLaunch !== "function" || Object.prototype.toString.call(assertMayLaunch) === "[object AsyncFunction]") {
    throw Object.assign(new TypeError("host_launch_preflight_must_be_synchronous"), { code: "host_launch_preflight_must_be_synchronous" });
  }
  // The shared read window rejects thenables and observes rejected Promises.
  // A returned flag/object is not an assertion or reusable launch capability.
  if (readSqliteWithinTransaction(database, assertMayLaunch) !== undefined) {
    throw Object.assign(new TypeError("host_launch_preflight_must_return_undefined"), { code: "host_launch_preflight_must_return_undefined" });
  }
}
