import { createPrivateKey, createPublicKey } from "node:crypto";

export function requireOfficialSigningKey(keyText, pinnedPublicKey, secretName) {
  if (!keyText?.trim()) throw new Error(`${secretName} is required.`);
  const key = createPrivateKey(keyText.trim());
  if (!createPublicKey(key).equals(createPublicKey(pinnedPublicKey))) {
    throw new Error(`${secretName} does not match the public key pinned in Ling.`);
  }
  return key;
}
