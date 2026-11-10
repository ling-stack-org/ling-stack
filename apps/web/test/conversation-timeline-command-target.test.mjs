import assert from "node:assert/strict";
import test from "node:test";
import { commandTarget } from "../src/shared/conversation/timeline/command-target.ts";

test("compact command target keeps inline interpreter flags and hides script payload", () => {
  assert.equal(commandTarget("node -e \"const fs=require('fs'); process.exit(0)\""), "node -e …");
  assert.equal(commandTarget("python -c \"print('ok')\""), "python -c …");
  assert.equal(commandTarget("bash -lc \"printf ok\""), "bash -lc …");
});

test("compact command target keeps ordinary command targets", () => {
  assert.equal(commandTarget("node script.js"), "node script.js");
  assert.equal(commandTarget("git status --short"), "git status");
  assert.equal(commandTarget("/usr/bin/node --eval=console.log(1)"), "node --eval …");
});

test("compact command target is empty for blank commands", () => {
  assert.equal(commandTarget("   "), "");
});
