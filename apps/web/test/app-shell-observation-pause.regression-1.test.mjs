import assert from "node:assert/strict";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { ts, visitTypeScriptNode, withTypeScriptSourceFiles } from "../scripts/typescript-ast.mjs";

// Regression: R03-OBS — channel execution detail escaped shared Host pause.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-packaging-retry-20261026/live-findings.md
// Value: protects=Shell read admission and fresh epoch retry; fails_when=paused selection reads or resume trusts old cached Run;
// why_new=Runs tests do not execute Shell effects; seam=none;
// no_claim=actual Shell effect with stubbed loadRun, not full React scheduling or packaged GUI.
const appPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const callback = withTypeScriptSourceFiles([appPath], files => {
  const source = files.get(appPath), matches = [];
  visitTypeScriptNode(source, node => {
    if (!ts.isCallExpression(node) || node.expression.getText(source) !== "useEffect") return;
    const body = node.arguments[0]?.getText(source) ?? "";
    if (body.includes("workspaceTimelineRunId") && body.includes("workspaceTimelineLoadRef")) matches.push(body);
  });
  assert.equal(matches.length, 1);
  return stripTypeScriptTypes(matches[0], { mode: "transform" }).trim().replace(/;$/, "");
}, { cwd: fileURLToPath(new URL("..", import.meta.url)) });

function fixture(paused = false) {
  const calls = [];
  const observation = { paused, epoch: 1 };
  const context = { activeView: "workspace", isRunning: false, workspaceTimelineRunId: "run-qa",
    form: { cwd: "/isolated/r03" }, workspaceTimelineLoadRef: { current: "" },
    daemonObservation: observation, daemonObservationRef: { current: observation }, run: undefined, events: [],
    loadRun: async (...args) => { calls.push(args); } };
  return { calls, context, effect: runInNewContext(`(${callback})`, context),
    observe(paused) { context.daemonObservation = { paused, epoch: context.daemonObservation.epoch + 1 };
      context.daemonObservationRef.current = context.daemonObservation; } };
}

test("paused channel timeline selection does not read or consume its retry key, then resumes", () => {
  const f = fixture(true); f.effect();
  assert.equal(f.calls.length, 0); assert.equal(f.context.workspaceTimelineLoadRef.current, "");
  f.observe(false); f.effect(); assert.equal(f.calls.length, 1);
  f.effect(); assert.equal(f.calls.length, 1, "one read per selection and observation epoch");
});

test("resume revalidates the same selected Run even when its old event snapshot is cached", () => {
  const f = fixture(); f.effect();
  f.context.run = { id: "run-qa", status: "running" }; f.context.events = [{ sequence: 1 }];
  f.observe(true); f.effect(); assert.equal(f.calls.length, 1);
  f.observe(false); f.effect(); assert.equal(f.calls.length, 2);
});

test("a callback captured before pause consults the current observation ref", () => {
  const f = fixture(); const oldCallback = f.effect;
  f.observe(true); oldCallback(); assert.equal(f.calls.length, 0);
});
