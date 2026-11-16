import { readFile } from "node:fs/promises";
import type { RemoteP256PublicJwkV1, RemoteResumeCursorV1 } from "@ling-stack/contracts";
import type {
  CanonicalJsonValue,
  RemoteAuthChallengeSigningInputV1,
  RemoteAuthProofSigningInputV1,
  RemoteCommandHashInputV1,
  RemotePairingAcceptedSigningInputV1,
  RemotePairingChallengeSigningInputV1,
  RemotePairingProofSigningInputV1,
} from "../dist/index.js";

export interface SignedFixture<Input> {
  input: Input;
  signingBytesBase64Url: string;
  signatureBase64Url: string;
}

interface IdentityFixture {
  publicKeyJwk: RemoteP256PublicJwkV1;
  fingerprint: string;
}

interface CanonicalSigningFixture {
  canonical: {
    value: CanonicalJsonValue;
    text: string;
    bytesBase64Url: string;
  };
  gatewayIdentity: IdentityFixture;
  deviceIdentity: IdentityFixture;
  pairingChallenge: SignedFixture<RemotePairingChallengeSigningInputV1>;
  pairingProof: SignedFixture<RemotePairingProofSigningInputV1> & {
    pairingSecretBase64Url: string;
    hmacBase64Url: string;
  };
  pairingAccepted: SignedFixture<RemotePairingAcceptedSigningInputV1>;
  authChallenge: SignedFixture<RemoteAuthChallengeSigningInputV1>;
  authProof: SignedFixture<RemoteAuthProofSigningInputV1>;
  resume: {
    cursors: RemoteResumeCursorV1[];
    hashBase64Url: string;
  };
  command: {
    input: RemoteCommandHashInputV1;
    hashInputBytesBase64Url: string;
    hashBase64Url: string;
  };
}

export const fixture: CanonicalSigningFixture = JSON.parse(await readFile(
  new URL("../fixtures/v1/canonical-signing.json", import.meta.url),
  "utf8",
));
