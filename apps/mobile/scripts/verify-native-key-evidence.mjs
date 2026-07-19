import { createPublicKey, verify } from "node:crypto";
import { decodeBase64Url, validateRemoteP256PublicJwkV1 } from "@ling-stack/remote-protocol";

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = Buffer.concat(chunks).toString("utf8").trim();
if (input.length === 0) {
  throw new Error("Pass the fixture result JSON on stdin");
}
const parsed = JSON.parse(input);
const evidence = parsed.nodeInteropEvidence ?? parsed;
const publicJwk = validateRemoteP256PublicJwkV1(evidence.publicJwk);
const key = createPublicKey({ key: publicJwk, format: "jwk" });
const verified = verify(
  "sha256",
  decodeBase64Url(evidence.messageBase64Url),
  { key, dsaEncoding: "ieee-p1363" },
  decodeBase64Url(evidence.signatureBase64Url),
);
if (!verified) {
  throw new Error("Native signature did not verify in Node");
}
process.stdout.write("PASS native-sign -> Node-verify\n");
