import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";

import { hmacSha256 } from "../dist/index.js";

test("dependency-free HMAC-SHA-256 matches RFC 4231 vectors", () => {
  const vectors = [
    {
      key: Buffer.alloc(20, 0x0b),
      message: Buffer.from("Hi There", "utf8"),
      expected: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    },
    {
      key: Buffer.from("Jefe", "utf8"),
      message: Buffer.from("what do ya want for nothing?", "utf8"),
      expected: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    },
    {
      key: Buffer.alloc(131, 0xaa),
      message: Buffer.from("Test Using Larger Than Block-Size Key - Hash Key First", "utf8"),
      expected: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    },
  ];

  for (const vector of vectors) {
    assert.equal(Buffer.from(hmacSha256(vector.key, vector.message)).toString("hex"), vector.expected);
  }
});

test("dependency-free HMAC-SHA-256 matches Node across key and block boundaries", () => {
  for (const keyLength of [0, 1, 32, 63, 64, 65, 128]) {
    for (const messageLength of [0, 1, 55, 56, 63, 64, 65, 257]) {
      const key = randomBytes(keyLength);
      const message = randomBytes(messageLength);
      const expected = createHmac("sha256", key).update(message).digest();
      assert.deepEqual(Buffer.from(hmacSha256(key, message)), expected);
    }
  }
});
