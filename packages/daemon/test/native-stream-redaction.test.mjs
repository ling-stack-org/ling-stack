import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeStreamRedactor } from "../dist/runtime/adapters/native-stream-redaction.js";
import * as nativeRedaction from "../dist/runtime/adapters/native-stream-redaction.js";

function stream(chunks, secrets = []) {
  const redactor = new NativeStreamRedactor(secrets);
  return chunks.map(chunk => redactor.push(chunk)).join("") + redactor.finish();
}

test("native stream redaction preserves ordinary live text and final whitespace", () => {
  const redactor = new NativeStreamRedactor([]);
  assert.equal(redactor.push("hello world "), "hello world ");
  assert.equal(redactor.push("再见。"), "再见。");
  assert.equal(redactor.finish(), "");
});

test("every split of known and patterned secrets is redacted before it leaves the stream", () => {
  const input = "before owned secret with spaces! Bearer abc.def123 sk-123456789012 after ";
  for (let split = 0; split <= input.length; split++) {
    assert.equal(stream([input.slice(0, split), input.slice(split)], ["owned secret with spaces!"]),
      "before [REDACTED] [REDACTED] [REDACTED] after ", `split=${split}`);
  }
  assert.equal(stream([...input], ["owned secret with spaces!"]), "before [REDACTED] [REDACTED] [REDACTED] after ");
});

test("a secret crossing the safe prefix and an incomplete auth scheme stay private", () => {
  assert.equal(stream(["before value with ", "spaces after "], ["value with spaces"]), "before [REDACTED] after ");
  assert.equal(stream(["Ba", "sic ", "YWJj", "ZGVm", ". end"]), "[REDACTED] end");
  assert.equal(stream(["an ordinary Bea", "con arrives "]), "an ordinary Beacon arrives ");
});

test("native stream output is bounded and cannot restart after finish", () => {
  const redactor = new NativeStreamRedactor([], 32);
  assert.throws(() => redactor.push("a".repeat(33)), { code: "capacity_exceeded" });
  const closed = new NativeStreamRedactor([]);
  closed.push("tail");
  assert.equal(closed.finish(), "tail");
  assert.throws(() => closed.push("late"), { code: "invalid_event" });
});

test("another secret prefix cannot split a complete authorization value", () => {
  const redactor = new NativeStreamRedactor(["cd tail next"]);
  const first = redactor.push("Bearer abcd tail ");
  assert.equal(first.includes("ab"), false);
  assert.equal(first + redactor.push("other ") + redactor.finish(), "[REDACTED] tail other ");
});

test("live registration preserves pending prefixes and redacts both old and rotated credentials", () => {
  const secrets = new nativeRedaction.NativeSecretRegistry(["old token with spaces"]);
  const redactor = new NativeStreamRedactor(secrets);
  const first = redactor.push("before old token with ");
  secrets.register(["new-access-token", "new-refresh-token"]);
  const output = first + redactor.push("spaces; new-access-token; new-refresh-token; old token with spaces. ") + redactor.finish();
  assert.equal(output, "before [REDACTED]; [REDACTED]; [REDACTED]; [REDACTED]. ");
  assert.deepEqual(nativeRedaction.redactNativeOutput({ text: "new-access-token" }, secrets), { text: "[REDACTED]" });
});

test("rotation between every split of an unfinished OAuth token cannot expose a prefix", () => {
  const value = "current.rotated-access_credential";
  for (let split = 0; split <= value.length; split++) {
    const secrets = new nativeRedaction.NativeSecretRegistry(["old-access"]);
    const redactor = new NativeStreamRedactor(secrets);
    const first = redactor.push(`before ${value.slice(0, split)}`);
    secrets.register([value]);
    assert.equal(first + redactor.push(`${value.slice(split)} after `) + redactor.finish(),
      "before [REDACTED] after ", `split=${split}`);
  }
});

test("secret registration is atomic, bounded, deduplicated and cannot mutate an older snapshot", () => {
  const secrets = new nativeRedaction.NativeSecretRegistry(["original"]);
  const original = secrets.getSnapshot();
  assert.throws(() => original.push("injected"), TypeError);
  for (const value of [["valid", ""], ["valid", undefined], ["valid", "x".repeat(8193)], new Array(1), "not-an-array", null]) {
    assert.throws(() => secrets.register(value), { code: "capacity_exceeded" });
    assert.strictEqual(secrets.getSnapshot(), original);
  }
  secrets.register(["original", "new"]);
  assert.deepEqual(original, ["original"]); assert.deepEqual(secrets.getSnapshot(), ["original", "new"]);
  const full = new nativeRedaction.NativeSecretRegistry(Array.from({ length: 128 }, (_, i) => `credential-${i}`));
  full.register(["credential-1"]);
  assert.equal(full.getSnapshot().length, 128);
  const before = full.getSnapshot();
  assert.throws(() => full.register(["overflow"]), { code: "capacity_exceeded" });
  assert.strictEqual(full.getSnapshot(), before);
  assert.throws(() => secrets.register(Array.from({ length: 48 }, (_, i) => `${i}${"\u4e00".repeat(8000)}`)),
    { code: "capacity_exceeded" });
  assert.deepEqual(secrets.getSnapshot(), ["original", "new"]);
});

test("plain secret arrays still use snapshot semantics and live registration never resets output bounds", () => {
  const values = ["original-token"], redactor = new NativeStreamRedactor(values);
  values[0] = "later-token";
  assert.equal(redactor.push("original-token later-token ") + redactor.finish(), "[REDACTED] later-token ");
  const secrets = new nativeRedaction.NativeSecretRegistry();
  const bounded = new NativeStreamRedactor(secrets, 8);
  bounded.push("1234567"); secrets.register(["12345678"]);
  assert.throws(() => bounded.push("89"), { code: "capacity_exceeded" });
  bounded.finish(); secrets.register(["new"]);
  assert.throws(() => bounded.push("late"), { code: "invalid_event" });
});
