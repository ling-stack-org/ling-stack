import assert from "node:assert/strict";
import test from "node:test";

import {
  protectMessage,
  protectedMessageParts,
  protectedMarkerPattern,
  restoreProtectedTokens,
  splitTranslatableText,
} from "../scripts/protected-tokens.mjs";

test("uses punctuation-free markers for protected product tokens", () => {
  const source = "Open Ling for Chrome from the Chrome toolbar and choose Resume.";
  const protectedValue = protectMessage(source);

  assert.equal(
    protectedValue.text,
    "Open __0__ for __1__ from the __2__ toolbar and choose Resume.",
  );
  assert.deepEqual(protectedValue.tokens, ["Ling", "Chrome", "Chrome"]);
  assert.equal(restoreProtectedTokens(protectedValue.text, protectedValue.tokens), source);
});

test("restores current and legacy marker wrappers without prefix collisions", () => {
  const tokens = Array.from({ length: 12 }, (_, index) => `token-${index}`);
  const restored = restoreProtectedTokens(
    "__0__ [XQZ1X] ［XQZ10X］ 【11XQZ11】",
    tokens,
  );

  assert.equal(restored, "token-0 token-1 token-10 token-11");
  assert.equal(protectedMarkerPattern.test(restored), false);
});

test("recognizes current and legacy marker residue", () => {
  assert.equal(protectedMarkerPattern.test("left __2__ behind"), true);
  assert.equal(protectedMarkerPattern.test("left \uE002 behind"), true);
  assert.equal(protectedMarkerPattern.test("left 2XQZ2 behind"), true);
  assert.equal(protectedMarkerPattern.test("left [XQZ2X] behind"), true);
  assert.equal(protectedMarkerPattern.test("left __LING_TOKEN_2__ behind"), true);
});

test("splits protected messages into deterministic text and token boundaries", () => {
  assert.deepEqual(
    protectedMessageParts("Show __0__ after __1__.", ["{count}", "Ling"]),
    [
      { kind: "text", value: "Show " },
      { kind: "token", value: "{count}" },
      { kind: "text", value: " after " },
      { kind: "token", value: "Ling" },
      { kind: "text", value: "." },
    ],
  );
});

test("splits repeatedly empty provider text at the nearest stable word boundary", () => {
  assert.deepEqual(
    splitTranslatableText("Check recent failed runs or automation errors."),
    {
      left: "Check recent failed runs",
      separator: " ",
      right: "or automation errors.",
    },
  );
  assert.equal(splitTranslatableText("Ling"), undefined);
});
