import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteDelegationCompletionEvidenceStore as BuiltReader } from "../dist/storage/sqlite/delegation-completion-evidence.js";
import { createHarnessReliabilityQueryCorpus, HARNESS_CORPUS_SPEC } from "../../../scripts/harness-reliability-corpus.mjs";
import { captureProductionRead } from "../../../scripts/harness-reliability-query-plans.mjs";

// Exercise the current authored reader without rebuilding or writing shared dist.
// Dependencies deliberately remain the separately recorded installed build lane.
const sourceUrl = new URL("../src/storage/sqlite/delegation-completion-evidence.ts", import.meta.url);
const builtUrl = new URL("../dist/storage/sqlite/delegation-completion-evidence.js", import.meta.url);
const source = stripTypeScriptTypes(await readFile(sourceUrl, "utf8"), { mode: "transform" })
  .replace(/from (["'])(\.[^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, builtUrl).href)}`);
const { SqliteDelegationCompletionEvidenceStore: SourceReader } = await import(`data:text/javascript,${encodeURIComponent(`${source}\n//# sourceURL=${sourceUrl.href}`)}`);

const portsFor = store => Object.fromEntries(["getRun", "getWorkUnit", "getWorkUnitAttempt", "getHostAttemptCompletion", "getArtifact"]
  .map(name => [name, store[name].bind(store)]));
const readerFor = (corpus, Reader = SourceReader) => new Reader({ database: corpus.store.database }, portsFor(corpus.store));
const read = reader => reader.getDelegationCompletionEvidence({ rootRunIds: ["corpus-root"] });

function predicateInvocations(invoke) {
  const methods = ["filter", "find", "some"], originals = new Map(methods.map(name => [name, Array.prototype[name]]));
  let invocations = 0;
  for (const name of methods) {
    const original = originals.get(name);
    Array.prototype[name] = function (predicate, thisArg) {
      const caller = new Error().stack?.split("\n")[2];
      if (!caller?.includes(fileURLToPath(sourceUrl))) return original.call(this, predicate, thisArg);
      return original.call(this, (...args) => { invocations += 1; return predicate.apply(thisArg, args); });
    };
  }
  try { return { value: invoke(), invocations }; }
  finally { for (const [name, original] of originals) Array.prototype[name] = original; }
}

function settleSyntheticReadFacts(corpus, unknown = false) {
  const db = corpus.database, now = HARNESS_CORPUS_SPEC.time;
  db.prepare(`UPDATE delegation_budget_charges SET state=?,input_tokens=?,cached_input_tokens=?,output_tokens=?,
    revision=revision+1,settled_at=?,updated_at=?`).run(unknown ? "unresolved" : "measured", unknown ? null : 0,
      unknown ? null : 0, unknown ? null : 0, unknown ? null : now, now);
  db.prepare(`UPDATE delegation_budget_reservations SET state='settled',settled_token_usage=0,settlement_digest=?,
    revision=revision+1,settled_at=?,updated_at=?`).run("0".repeat(64), now, now);
}

test("completion predicate work scales no faster than its actual fact population, including settled child aggregation", async t => {
  const work = [];
  for (const scale of [4, 8]) {
    const corpus = await createHarnessReliabilityQueryCorpus({ scale });
    t.after(() => corpus.close());
    settleSyntheticReadFacts(corpus);
    const result = predicateInvocations(() => read(readerFor(corpus)));
    assert.ok(result.invocations > 0, "authored-reader predicate observation must not silently disappear");
    assert.deepEqual(result.value.issues, []);
    const population = ["run_sessions", "delegation_steps", "delegation_messages", "delegation_budget_reservations", "delegation_budget_charges", "delegation_root_budgets"]
      .reduce((sum, table) => sum + Number(corpus.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 0);
    work.push({ scale, population, invocations: result.invocations });
  }
  t.diagnostic(`completion predicate work: ${JSON.stringify(work)}`);
  assert.ok(work[1].invocations * work[0].population <= work[0].invocations * work[1].population,
    `superlinear completion predicate work: ${JSON.stringify(work)}`);
});

for (const corruption of ["none", "foreign-reservation", "unknown-usage"]) {
  test(`linear reader preserves the complete canonical read set and failures: ${corruption}`, async t => {
    const corpus = await createHarnessReliabilityQueryCorpus({ scale: 4 });
    t.after(() => corpus.close());
    if (corruption === "foreign-reservation") {
      // Corruption injection stays in this disposable QA database only.
      corpus.database.exec("DROP TRIGGER trg_delegation_budget_charges_update_guard");
      corpus.database.prepare("UPDATE delegation_budget_charges SET reservation_id=? WHERE id=?")
        .run("corpus-delegation-selected-00001:reservation", "corpus-delegation-selected-00000:charge");
    } else if (corruption === "unknown-usage") settleSyntheticReadFacts(corpus, true);
    const authored = read(readerFor(corpus)), built = read(readerFor(corpus, BuiltReader));
    assert.deepEqual(authored, built);
    if (corruption !== "none") {
      assert.equal(authored.status, "blocked");
      assert.ok(authored.issues.some(issue => issue.code === (corruption === "foreign-reservation"
        ? "delegation.completion_lineage_invalid" : "delegation.completion_usage_invalid")));
    }
  });
}

test("one reservation-leading index removes the captured production charge history scan without changing evidence", async t => {
  const corpus = await createHarnessReliabilityQueryCorpus({ scale: 4 });
  t.after(() => corpus.close());
  const reader = readerFor(corpus), capture = () => captureProductionRead(corpus.store.database, () => read(reader));
  const before = capture();
  corpus.database.exec("CREATE INDEX qa_completion_reservation ON delegation_budget_charges(reservation_id)");
  const after = capture();
  assert.deepEqual(after.value, before.value);
  const charges = after.queries.filter(query => query.sql.includes("SELECT * FROM delegation_budget_charges"));
  assert.equal(charges.length, 1);
  assert.deepEqual(charges[0].persistentScans, []);
  assert.ok(charges[0].plan.some(row => /SEARCH delegation_budget_charges USING INDEX .*reservation/.test(row.detail)));
});
