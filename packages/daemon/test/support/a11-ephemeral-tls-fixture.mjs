import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

const VALIDITY_MS = 10 * 60 * 1_000;
const CLOCK_SKEW_MS = 60 * 1_000;
const SAN = "*.a11.test";

/** Test-only, in-memory P-256 self-signed CA/server certificate and random key. */
export function createA11EphemeralTlsFixture({ now = new Date(), validityMs = VALIDITY_MS } = {}) {
  const timestamp = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(validityMs) || validityMs < 1_000 || validityMs > VALIDITY_MS) {
    throw new Error("a11_ephemeral_tls_fixture_invalid_lifetime");
  }
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const serial = randomBytes(16);
    serial[0] = (serial[0] & 0x7f) | 1;
    const algorithm = sequence(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
    const name = sequence(der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from("A11 ephemeral offline CA")))));
    const notBefore = timestamp - CLOCK_SKEW_MS;
    const notAfter = timestamp + validityMs;
    const extensions = sequence(
      sequence(oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
      sequence(oid("2.5.29.17"), der(0x04, sequence(der(0x82, Buffer.from(SAN, "ascii"))))),
      sequence(oid("2.5.29.15"), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([2, 0x84])))),
      sequence(oid("2.5.29.37"), der(0x04, sequence(oid("1.3.6.1.5.5.7.3.1")))),
    );
    const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name,
      sequence(utcTime(notBefore), utcTime(notAfter)), name, publicKey.export({ type: "spki", format: "der" }), der(0xa3, extensions));
    const certificate = new X509Certificate(sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)]))));
    const actualStart = Date.parse(certificate.validFrom);
    const actualEnd = Date.parse(certificate.validTo);
    if (!certificate.ca || !certificate.verify(publicKey) || !certificate.checkPrivateKey(privateKey) ||
      certificate.checkHost("preview.a11.test") !== SAN || certificate.checkHost("wrong.other.test") !== undefined ||
      actualStart > timestamp || actualStart < notBefore - 1_000 || actualEnd <= timestamp || actualEnd > notAfter ||
      actualEnd - actualStart > VALIDITY_MS + CLOCK_SKEW_MS) {
      throw new Error("a11_ephemeral_tls_fixture_unconfirmed");
    }
    // Keep the random key as KeyObject; only the native TLS test adapter may
    // materialize its API-required PEM in memory. Neither form is logged/written.
    return Object.freeze({ key: privateKey, cert: certificate.toString(), certificate });
  } catch (cause) {
    throw new Error("a11_ephemeral_tls_fixture_generation_failed", { cause });
  }
}

/** Small DER primitives for this one fixed certificate shape, not an ASN.1 API. */
function der(tag, bytes) {
  const length = bytes.length;
  const lengthBytes = [];
  if (length < 128) lengthBytes.push(length);
  else {
    let rest = length;
    while (rest > 0) { lengthBytes.unshift(rest & 0xff); rest >>>= 8; }
    lengthBytes.unshift(0x80 | lengthBytes.length);
  }
  return Buffer.concat([Buffer.from([tag, ...lengthBytes]), bytes]);
}
function sequence(...items) { return der(0x30, Buffer.concat(items)); }
function oid(value) {
  const parts = value.split(".").map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    let rest = Math.floor(part / 128);
    while (rest > 0) { encoded.unshift((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}
function utcTime(timestamp) {
  const date = new Date(timestamp);
  if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() >= 2050) throw new Error("a11_ephemeral_tls_fixture_unsupported_clock");
  const encoded = date.toISOString().slice(2, 19).replace(/[-:T]/gu, "") + "Z";
  return der(0x17, Buffer.from(encoded, "ascii"));
}
