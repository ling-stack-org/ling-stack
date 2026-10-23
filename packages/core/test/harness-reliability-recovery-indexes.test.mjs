import assert from "node:assert/strict";
import test from "node:test";
import { runHarnessReliabilityQueryPlans } from "../../../scripts/harness-reliability-query-plans.mjs";

test("real startup pages and completion charges avoid persistent history scans", async () => {
  const evidence = await runHarnessReliabilityQueryPlans({ scales: [4, 8], pageSize: 2 });
  assert.equal(evidence.externalProviderCalls, 0);
  for (const measurement of evidence.measurements) {
    for (const [name, read] of Object.entries(measurement.startup)) {
      assert.equal(read.returned, 2, name);
      for (const query of read.queries) {
        assert.deepEqual(query.persistentScans, [], `${name}: ${query.sql}`);
        assert.equal(query.usesTemporaryOrder, false, `${name}: ${query.sql}`);
      }
    }
    for (const query of measurement.completion.queries) {
      assert.deepEqual(query.persistentScans, [], `completion: ${query.sql}`);
    }
  }
});
