import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { encodeBase64Url, encodeUtf8, sha256 } from "../dist/index.js";

test("dependency-free SHA-256 matches standard vectors", () => {
  const vectors = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["远程 Ling 😀", createHash("sha256").update("远程 Ling 😀").digest("hex")],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(Buffer.from(sha256(encodeUtf8(input))).toString("hex"), expected);
  }
});

test("dependency-free SHA-256 matches Node across block boundaries", () => {
  for (const length of [1, 31, 55, 56, 57, 63, 64, 65, 127, 128, 255, 1024]) {
    const bytes = randomBytes(length);
    assert.equal(
      encodeBase64Url(sha256(bytes)),
      createHash("sha256").update(bytes).digest("base64url"),
    );
  }
});
