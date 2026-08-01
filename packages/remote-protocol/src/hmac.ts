import { sha256 } from "./sha256.js";

const SHA256_BLOCK_BYTES = 64;

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

/** Dependency-free HMAC-SHA-256 for the shared pairing transcript. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const normalizedKey = key.length > SHA256_BLOCK_BYTES ? sha256(key) : key;
  const innerPad = new Uint8Array(SHA256_BLOCK_BYTES);
  const outerPad = new Uint8Array(SHA256_BLOCK_BYTES);

  for (let index = 0; index < SHA256_BLOCK_BYTES; index += 1) {
    const keyByte = normalizedKey[index] ?? 0;
    innerPad[index] = keyByte ^ 0x36;
    outerPad[index] = keyByte ^ 0x5c;
  }

  return sha256(concatenate(outerPad, sha256(concatenate(innerPad, message))));
}
