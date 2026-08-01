import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";
import {
  es256DerToP1363,
  es256P1363ToDer,
} from "../dist/index.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const message = Buffer.from("ling remote native signature bridge", "utf8");

test("native DER signatures round-trip through the fixed V1 P1363 wire encoding", () => {
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const der = sign("sha256", message, privateKey);
    const p1363 = es256DerToP1363(der);
    assert.equal(p1363.length, 64);
    assert.equal(verify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, p1363), true);
    assert.equal(verify("sha256", message, publicKey, es256P1363ToDer(p1363)), true);
  }
});

test("DER conversion rejects ambiguous or malformed signatures", () => {
  assert.throws(() => es256DerToP1363(Uint8Array.of(0x30, 0x00)), /DER/);
  assert.throws(
    () => es256DerToP1363(Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01)),
    /positive/,
  );
  assert.throws(
    () => es256DerToP1363(Uint8Array.of(0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01)),
    /padding/,
  );
  assert.throws(() => es256P1363ToDer(new Uint8Array(63)), /64 bytes/);
});

test("DER conversion rejects zero and out-of-range P-256 scalars", () => {
  const order = Buffer.from("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", "hex");
  const one = Buffer.alloc(32);
  one[31] = 1;

  assert.throws(
    () => es256DerToP1363(Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01)),
    /P-256 order/,
  );
  assert.throws(() => es256P1363ToDer(Buffer.concat([Buffer.alloc(32), one])), /P-256 order/);
  assert.throws(() => es256P1363ToDer(Buffer.concat([one, order])), /P-256 order/);
});
