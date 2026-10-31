#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDelegationLifecycleStore } from "../packages/core/dist/storage/sqlite/delegation-lifecycle-store.js";
import { createHarnessReliabilityQueryCorpus, HARNESS_CORPUS_SPEC } from "./harness-reliability-corpus.mjs";

const persistentTables = new Set(["run_sessions", "work_units", "work_unit_attempts", "runner_continuations",
  "delegation_steps", "delegation_messages", "delegation_root_budgets", "delegation_budget_reservations", "delegation_budget_charges"]);
const reservedWords = new Set(["WHERE", "JOIN", "ON", "ORDER", "LIMIT", "UNION", "GROUP", "LEFT", "INNER", "USING"]);
const digest = value => createHash("sha256").update(value).digest("hex");

/** A full covering-index walk is still a persistent history scan. CTE/json scans are not. */
export function persistentScans(sql, plan) {
  const aliases = new Map();
  for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9]*)(?:\s+(?:AS\s+)?([a-z_][a-z_0-9]*))?/gi)) {
    const [, table, alias] = match;
    if (!persistentTables.has(table)) continue;
    aliases.set(table, table);
    if (alias && !reservedWords.has(alias.toUpperCase())) aliases.set(alias, table);
  }
  return plan.flatMap(row => {
    const relation = /\bSCAN (?:TABLE )?([a-z_][a-z_0-9]*)\b/i.exec(row.detail)?.[1];
    return relation && aliases.has(relation) ? [row.detail] : [];
  });
}

/** Intercept the real production connection for one synchronous read, then EXPLAIN
 * exactly those executed SELECT/WITH strings with the original binding values.
 * No guessed SQL, fake rows, timing measurement, or SQL rewriting is used.
 */
export function captureProductionRead(database, invoke) {
  const originalPrepare = database.prepare;
  const descriptor = Object.getOwnPropertyDescriptor(database, "prepare");
  const captured = [];
  Object.defineProperty(database, "prepare", { configurable: true, value(sql) {
    const statement = originalPrepare.call(database, sql);
    return new Proxy(statement, { get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      if (!["all", "get"].includes(key) || !/^\s*(?:SELECT|WITH)\b/i.test(sql)) return method.bind(target);
      return (...bindings) => {
        const result = method.apply(target, bindings);
        captured.push({ sql, rawBindings: bindings, operation: key,
          rowCount: key === "all" ? result.length : result === undefined ? 0 : 1 });
        return result;
      };
    } });
  } });
  let value;
  try {
    value = invoke();
    if (value && typeof value.then === "function") throw new TypeError("harness_query_capture_requires_synchronous_read");
  } finally {
    if (descriptor) Object.defineProperty(database, "prepare", descriptor);
    else delete database.prepare;
  }
  const queries = captured.map(({ rawBindings, ...query }) => {
    const plan = originalPrepare.call(database, `EXPLAIN QUERY PLAN ${query.sql}`).all(...rawBindings)
      .map(row => ({ id: Number(row.id), parent: Number(row.parent), detail: String(row.detail) }));
    const bindings = JSON.parse(JSON.stringify(rawBindings, (_key, entry) => typeof entry === "bigint" ? { bigint: String(entry) } : entry));
    return { ...query, sqlSha256: digest(query.sql), bindings, plan,
      persistentScans: persistentScans(query.sql, plan), usesTemporaryOrder: plan.some(row => /USE TEMP B-TREE FOR (?:.* )?ORDER BY/i.test(row.detail)) };
  });
  return { value, queries };
}

/** Count actual predicate invocations at production completion-reader callsites.
 * This is structural work evidence, intentionally separate from wall-clock perf.
 */
function captureCompletionPredicates(invoke) {
  const originals = new Map(), sites = new Map();
  for (const method of ["filter", "find", "some"]) {
    const original = Array.prototype[method];
    originals.set(method, original);
    Array.prototype[method] = function (predicate, thisArg) {
      const site = new Error().stack?.split("\n")[2];
      if (!site?.includes("/dist/storage/sqlite/delegation-completion-evidence.js:") || typeof predicate !== "function") {
        return original.call(this, predicate, thisArg);
      }
      const key = `${method}:${site.trim()}`;
      let counter = sites.get(key);
      if (!counter) { counter = { method, callsite: site.trim(), calls: 0, invocations: 0, maxInputLength: 0 }; sites.set(key, counter); }
      counter.calls += 1; counter.maxInputLength = Math.max(counter.maxInputLength, this.length);
      return original.call(this, function (...args) { counter.invocations += 1; return predicate.apply(thisArg, args); });
    };
  }
  try {
    const value = invoke();
    return { value, predicateWork: { totalInvocations: [...sites.values()].reduce((sum, site) => sum + site.invocations, 0), sites: [...sites.values()] } };
  } finally { for (const [method, original] of originals) Array.prototype[method] = original; }
}

const summarize = ({ value, queries }, returned) => ({ returned: returned(value), queryCount: queries.length, queries });
const indexedGate = result => result.queries.length > 0 && result.queries.every(query => query.persistentScans.length === 0 && !query.usesTemporaryOrder);

async function productionDigests() {
  const sourceDigests = {};
  for (const path of ["scripts/harness-reliability-corpus.mjs", "scripts/harness-reliability-query-plans.mjs",
    "packages/core/src/storage/sqlite-run-store.ts", "packages/core/dist/storage/sqlite-run-store.js",
    ...["delegation-store", "delegation-completion-evidence", "delegation-lifecycle-store", "runner-continuation-store", "runtime-work-unit-store",
      "delegation-migration", "delegation-budget-migration", "runner-continuation-migration", "harness-recovery-index-migration", "migrations"]
      .flatMap(name => [`packages/core/src/storage/sqlite/${name}.ts`, `packages/core/dist/storage/sqlite/${name}.js`])]) {
    try { sourceDigests[path] = digest(await readFile(new URL(`../${path}`, import.meta.url))); }
    catch (error) {
      if (path === "packages/core/dist/storage/sqlite/harness-recovery-index-migration.js" && error.code === "ENOENT") sourceDigests[path] = null;
      else throw error;
    }
  }
  return sourceDigests;
}

/** Synthetic on-disk structural gate only; original five latency/sample gates live
 * unchanged in harness-reliability-benchmark.mjs and must be run independently.
 */
export async function runHarnessReliabilityQueryPlans({ scales = [16, 128, 1024], pageSize = 8 } = {}) {
  if (!Array.isArray(scales) || scales.length < 2 || scales.some((value, index) => !Number.isSafeInteger(value)
    || value <= pageSize || value > 2_000 || index > 0 && value <= scales[index - 1])
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError("harness_query_scale_invalid");
  const sourceDigests = await productionDigests();
  const measurements = [];
  let sqliteVersion, indexDefinitions;
  for (const scale of scales) {
    const corpus = await createHarnessReliabilityQueryCorpus({ scale });
    try {
      const db = corpus.store.database, now = HARNESS_CORPUS_SPEC.time;
      sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
      indexDefinitions ??= db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN (SELECT value FROM json_each(?)) ORDER BY name")
        .all(JSON.stringify([...persistentTables])).map(row => ({ name: row.name, table: row.tbl_name, sql: row.sql }));
      const capture = invoke => captureProductionRead(db, invoke);
      const firstChildren = corpus.store.queryDelegationChildren(corpus.delegationParentId, { limit: pageSize });
      const firstMessages = corpus.store.queryDelegationMessages(corpus.delegationParentId, { limit: pageSize });
      const children = summarize(capture(() => corpus.store.queryDelegationChildren(corpus.delegationParentId, { limit: pageSize })), value => value.items.length);
      const childrenAfter = summarize(capture(() => corpus.store.queryDelegationChildren(corpus.delegationParentId,
        { limit: pageSize, after: firstChildren.nextCursor })), value => value.items.length);
      const messages = summarize(capture(() => corpus.store.queryDelegationMessages(corpus.delegationParentId, { limit: pageSize })), value => value.items.length);
      const messagesAfter = summarize(capture(() => corpus.store.queryDelegationMessages(corpus.delegationParentId,
        { limit: pageSize, after: firstMessages.nextCursor })), value => value.items.length);
      // Match DaemonRunnerRecoveryCoordinator's task_run discovery options.
      const staleOptions = { status: "stale", kind: "task_run", createdAtOrBefore: now, limit: pageSize };
      const firstStale = corpus.store.listWorkUnits(staleOptions);
      const staleWorkUnits = summarize(capture(() => corpus.store.listWorkUnits(staleOptions)), value => value.length);
      const lastStale = firstStale.at(-1);
      const staleWorkUnitsAfter = summarize(capture(() => corpus.store.listWorkUnits({ ...staleOptions,
        after: { createdAt: lastStale.createdAt, id: lastStale.id } })), value => value.length);
      const scheduledOptions = { now, createdAtOrBefore: now, scheduledOnly: true, limit: pageSize };
      const firstScheduled = corpus.store.listClaimableRunnerContinuations(scheduledOptions);
      const scheduledContinuations = summarize(capture(() => corpus.store.listClaimableRunnerContinuations(scheduledOptions)), value => value.length);
      const lastScheduled = firstScheduled.at(-1);
      const scheduledContinuationsAfter = summarize(capture(() => corpus.store.listClaimableRunnerContinuations({ ...scheduledOptions,
        after: { dueAt: lastScheduled.nextAttemptAt ?? lastScheduled.createdAt, createdAt: lastScheduled.createdAt, id: lastScheduled.id } })), value => value.length);
      // Only this production leaf's discovery method is invoked; it has no need
      // for lifecycle mutation ports, authorization receipts, Runner or Provider.
      const lifecycle = new SqliteDelegationLifecycleStore({ database: db }, {});
      const firstDelegated = lifecycle.listDelegatedRecoveryCandidates({ cutoffAt: now, limit: pageSize });
      const delegatedRecovery = summarize(capture(() => lifecycle.listDelegatedRecoveryCandidates({ cutoffAt: now, limit: pageSize })), value => value.reservationIds.length);
      const delegatedRecoveryAfter = summarize(capture(() => lifecycle.listDelegatedRecoveryCandidates({ cutoffAt: now, limit: pageSize,
        cursor: firstDelegated.nextCursor })), value => value.reservationIds.length);
      const completionCapture = captureCompletionPredicates(() => capture(() => corpus.store.getDelegationCompletionEvidence({ rootRunIds: [corpus.root.id] })));
      const completion = { ...summarize(completionCapture.value, value => value.steps.length),
        status: completionCapture.value.value.status,
        issueCodes: [...new Set(completionCapture.value.value.issues.map(issue => issue.code))].sort(),
        predicateWork: completionCapture.predicateWork };
      const cardinality = {};
      for (const table of persistentTables) cardinality[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
      measurements.push({ scale, pageSize, corpusDigest: corpus.corpusDigest, cardinality,
        delegation: { children, childrenAfter, messages, messagesAfter },
        startup: { staleWorkUnits, staleWorkUnitsAfter, scheduledContinuations, scheduledContinuationsAfter, delegatedRecovery, delegatedRecoveryAfter }, completion });
    } finally { await corpus.close(); }
  }
  const predicateGrowth = [];
  for (let index = 1; index < measurements.length; index += 1) {
    const smaller = measurements[index - 1], larger = measurements[index];
    const population = row => row.cardinality.delegation_steps + row.cardinality.delegation_messages
      + row.cardinality.delegation_budget_charges + row.cardinality.delegation_budget_reservations + row.cardinality.delegation_root_budgets;
    const smallPopulation = population(smaller), largePopulation = population(larger);
    for (const site of larger.completion.predicateWork.sites) {
      const previous = smaller.completion.predicateWork.sites.find(candidate => candidate.callsite === site.callsite && candidate.method === site.method);
      if (!previous?.invocations) continue;
      predicateGrowth.push({ fromScale: smaller.scale, toScale: larger.scale, method: site.method, callsite: site.callsite,
        fromInvocations: previous.invocations, toInvocations: site.invocations, fromPopulation: smallPopulation, toPopulation: largePopulation,
        observedSuperlinearWork: site.invocations * smallPopulation > previous.invocations * largePopulation });
    }
  }
  const gates = {
    recordedBuildInputsPresent: Object.values(sourceDigests).every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)),
    delegationPagesUseScopedIndexes: measurements.every(row => Object.values(row.delegation).every(indexedGate)),
    startupPagesUseScopedIndexes: measurements.every(row => Object.values(row.startup).every(indexedGate)),
    completionNotTruncated: measurements.every(row => !row.completion.issueCodes.includes("delegation.completion_limit_exceeded")),
    completionHasNoPersistentHistoryScan: measurements.every(row => row.completion.queries.every(query => query.persistentScans.length === 0)),
    completionHasNoObservedSuperlinearPredicateWork: predicateGrowth.length > 0 && !predicateGrowth.some(row => row.observedSuperlinearWork),
  };
  if (JSON.stringify(sourceDigests) !== JSON.stringify(await productionDigests())) throw new Error("harness_query_sources_changed_during_run");
  const git = (...args) => execFileSync("git", args, { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }).trim();
  return { schemaVersion: 1, scope: "synthetic_on_disk_production_query_plans_and_predicate_counts", externalProviderCalls: 0,
    corpus: HARNESS_CORPUS_SPEC, environment: { node: process.version, sqlite: sqliteVersion, gitHead: git("rev-parse", "HEAD"),
      gitTrackedDirty: Boolean(git("status", "--porcelain", "--untracked-files=no")), sourceDigests },
    schema: { indexDefinitions, sha256: digest(JSON.stringify(indexDefinitions)) }, measurements, predicateGrowth,
    gates, passed: Object.values(gates).every(Boolean), limits: [
      "Structural operation counts and plans, not latency or packaged GUI acceptance; run the unchanged five performance gates separately.",
      "Source and executed dist digests are separate evidence; acceptance requires the owner to fresh-build before this run.",
      "Nonterminal synthetic read graph is not delegation execution/authority/completion-success acceptance.",
      "Observed superlinear predicate work is evidence at these scales, not a universal asymptotic or wall-clock claim.",
    ] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1];
  const result = await runHarnessReliabilityQueryPlans({ scales: (argument("scales") ?? "16,128,1024").split(",").map(Number),
    pageSize: Number(argument("page-size") ?? 8) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
