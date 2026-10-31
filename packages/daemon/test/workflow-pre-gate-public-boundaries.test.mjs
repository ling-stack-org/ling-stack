import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const runChild = promisify(execFile);
const scenarios = [
  ["override-taskTitle", "different title is rejected before admission"],
  ["override-taskPrompt", "different prompt is rejected before admission"],
  ["override-providerPresetId", "Step Provider takes precedence over the Channel default"],
  ["override-runnerId", "different explicit Runner is rejected before admission"],
  ["override-implicit-runner", "an explicit Runner is not equivalent to implicit routing"],
  ["override-channel-provider", "a missing Step Provider uses the Channel default"],
  ["equivalent-explicit", "equal overrides preserve one pending permission and one consumed Task"],
  ["equivalent-omitted", "omitted overrides preserve one pending permission and one consumed Task"],
  ["ungated-overrides", "ungated starts retain non-equivalent overrides"],
  ["select-first-applicable", "first applicable declarative gate conservatively merges the builtin profile"],
  ["select-absent", "absent requiredForStatuses applies to the current status"],
  ["select-empty-no-builtin", "empty requiredForStatuses applies to no status"],
  ["select-empty-with-builtin", "empty declarative statuses cannot disable the builtin gate"],
  ["select-none-with-builtin", "mode none and post-only gates cannot disable the builtin gate"],
  ["select-default-risk-union", "profile defaults retain maximum risk and union requirements"],
  ["select-builtin-none", "a disabled builtin profile does not impose hidden requirements"],
  ["tool-deny-after-pre", "approved pre permission does not override actual read denial"],
  ["startup-approve", "real Daemon restart reconciles approval without starting execution"],
  ["startup-deny", "real Daemon restart reconciles denial without starting execution"],
  ["startup-pending", "real Daemon restart preserves pending pre admission"],
  ["startup-approved-projection", "real Daemon restart preserves already-resolved pre admission"],
  ["startup-deny-fail", "real Daemon restart honors fail_workflow denial policy"],
  ["startup-deny-cancel", "real Daemon restart honors cancel_workflow denial policy"],
  ["startup-deny-skip", "real Daemon restart skips only the pre Step, not aggregate success"],
  ["startup-expired", "real Daemon restart keeps expired pre permission blocked"],
  ["startup-cancelled", "real Daemon restart keeps cancelled pre permission blocked"],
  ["startup-stale-definition", "real Daemon restart cannot apply a decision to a changed definition"],
  ["startup-missing-basis", "real Daemon restart cannot upgrade an old no-basis pre decision"],
];

/** Each public case owns its complete home, workspace, database and environment. */
async function runPublicBoundaryCase(t, scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b013-boundary-")));
  const cwd = join(root, "workspace"), home = join(root, "home");
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  t.after(async () => {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b013-boundary-`));
    await fs.rm(root, { recursive: true, force: true });
  });
  let execution;
  try {
    execution = await runChild(process.execPath, [new URL("./support/b013-pre-gate-boundary-fixture.mjs", import.meta.url).pathname, scenario], {
      cwd, timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
      env: { HOME: home, TMPDIR: os.tmpdir(), PATH: process.env.PATH ?? "/usr/bin:/bin",
        LING_STACK_HOME: home, LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, B013_BOUNDARY_OWNED_ROOT: root },
    });
  } catch (error) {
    assert.fail(`B013 boundary child has no controlled verdict: ${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
  }
  const line = execution.stdout.split("\n").findLast(entry => entry.startsWith("B013_BOUNDARY_RESULT "));
  assert.ok(line, `missing isolated fixture verdict: ${execution.stdout}\n${execution.stderr}`);
  const report = JSON.parse(line.slice("B013_BOUNDARY_RESULT ".length));
  t.diagnostic(JSON.stringify(report));
  assert.equal(report.externalFetches, 0, "no Provider or external fetch is allowed");
  assert.equal(report.keychainAccesses, 0, "no system credential access is allowed");
  assert.equal(report.phase, "product_assertion", `setup failure is not a product RED: ${JSON.stringify(report)}`);
  assert.equal(report.ok, true, JSON.stringify(report));
}

for (const [scenario, contract] of scenarios) {
  test(`B013 HTTP boundary: ${contract}`, { timeout: 55_000 }, async t => runPublicBoundaryCase(t, scenario));
}
