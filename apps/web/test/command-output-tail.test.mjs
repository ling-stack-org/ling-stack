import assert from "node:assert/strict";
import test from "node:test";
import { formatCommandOutputTail } from "../src/lib/command-output-tail.ts";

test("split chunks of one stream stay byte-adjacent", () => {
  assert.equal(formatCommandOutputTail([
    { stream: "stdout", text: "first " },
    { stream: "stdout", text: "line\n" },
  ]), "first line\n");
});

test("stdout and stderr boundaries stay legible without changing stream order", () => {
  assert.equal(formatCommandOutputTail([
    { stream: "stdout", text: "first " },
    { stream: "stdout", text: "line" },
    { stream: "stderr", text: "warning\n" },
    { stream: "stdout", text: "last" },
  ]), "stdout:\nfirst line\nstderr:\nwarning\nstdout:\nlast");
});

test("empty chunks cannot manufacture a stream transition", () => {
  assert.equal(formatCommandOutputTail([
    { stream: "stdout", text: "ok\n" },
    { stream: "stderr", text: "" },
  ]), "ok\n");
});
