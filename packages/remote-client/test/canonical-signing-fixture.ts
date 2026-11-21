import { readFile } from "node:fs/promises";
import type { RemoteP256PublicJwkV1 } from "@ling-stack/contracts";

interface IdentityFixture {
  publicKeyJwk: RemoteP256PublicJwkV1;
  fingerprint: string;
}

interface SignedFixture {
  input: { serverNonce: string };
  signatureBase64Url: string;
}

export interface RemoteClientFixture {
  gatewayIdentity: IdentityFixture;
  deviceIdentity: IdentityFixture;
  pairingProof: { pairingSecretBase64Url: string; signatureBase64Url: string };
  pairingChallenge: SignedFixture;
  pairingAccepted: { signatureBase64Url: string };
  authChallenge: SignedFixture;
  authProof: { signatureBase64Url: string };
}

export const fixture: RemoteClientFixture = JSON.parse(await readFile(
  new URL("../../remote-protocol/fixtures/v1/canonical-signing.json", import.meta.url),
  "utf8",
));
