import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("both resource-probe phases reject missing/forged leases and outside scratch before any candidate read", () => {
  for (const phase of ["retain-real", "reopen"]) {
    for (const kind of ["missing", "forged", "outside"]) {
      const env = { ...process.env, LING_GSTACK_EXECUTABLE_BUNDLE: "/must-not-read-candidate" };
      if (kind === "missing") { delete env.LING_GSTACK_RESOURCE_ROOT; delete env.LING_GSTACK_RESOURCE_TOKEN; }
      if (kind === "forged") env.LING_GSTACK_RESOURCE_TOKEN = "forged-token";
      const result = spawnSync(process.execPath, [new URL("retained-resource-probe.mjs", import.meta.url).pathname,
        "/must-not-read-work", phase, "/must-not-read-selection"], { env, encoding: "utf8", timeout: 10000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, kind === "outside" ? /work_outside_scratch/ : /resource_lease_(required|mismatch)/);
      assert.doesNotMatch(result.stderr, /ENOENT|executable_root_alias/);
    }
  }
});
