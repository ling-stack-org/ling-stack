import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRestrictedCommandFixture } from "./support/restricted-command-fixture.mjs";

test("direct Host entry cannot silently run a typed command without its restricted backend", async t => {
  const f = await createRestrictedCommandFixture(t, `node -e "require('node:fs').writeFileSync('must-not-run','unsafe')"`);
  const result = await f.execute();
  assert.equal(result.isError, true, "typed calls must not fall back to raw Host spawn");
  assert.match(result.content[0].text, /operation_binding_isolation_unavailable/);
  await assert.rejects(readFile(join(f.cwd, "must-not-run")), { code: "ENOENT" });
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0, "unstarted refusal must not create a blocking journal reservation");
});
