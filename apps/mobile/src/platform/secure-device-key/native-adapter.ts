import {
  decodeBase64Url,
  encodeBase64Url,
  es256DerToP1363,
  es256P1363ToDer,
  validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";

import LingSecureDeviceKey from "../../../modules/ling-secure-device-key";
import type { SecureDeviceKeyAdapter, SecureDeviceKeyInfo } from "./types";

function validateKeyId(keyId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)) {
    throw new Error("invalid_secure_device_key_id");
  }
}

export const nativeSecureDeviceKeyAdapter: SecureDeviceKeyAdapter = {
  async generateOrLoad(keyId): Promise<SecureDeviceKeyInfo> {
    validateKeyId(keyId);
    const info = await LingSecureDeviceKey.generateOrLoad(keyId);
    if (info.privateKeyExportable !== false) {
      throw new Error("private_key_exportability_invariant_failed");
    }
    return {
      ...info,
      publicJwk: validateRemoteP256PublicJwkV1(info.publicJwk),
    };
  },

  async sign(keyId, message): Promise<string> {
    validateKeyId(keyId);
    const nativeSignature = await LingSecureDeviceKey.sign(keyId, encodeBase64Url(message));
    if (nativeSignature.encoding !== "x962_der") {
      throw new Error("unsupported_native_signature_encoding");
    }
    return encodeBase64Url(es256DerToP1363(decodeBase64Url(nativeSignature.signatureBase64Url)));
  },

  async verify(publicJwk, message, p1363SignatureBase64Url): Promise<boolean> {
    const validatedJwk = validateRemoteP256PublicJwkV1(publicJwk);
    const derSignature = es256P1363ToDer(decodeBase64Url(p1363SignatureBase64Url));
    return LingSecureDeviceKey.verify(
      validatedJwk,
      encodeBase64Url(message),
      encodeBase64Url(derSignature),
    );
  },

  async delete(keyId): Promise<void> {
    validateKeyId(keyId);
    await LingSecureDeviceKey.delete(keyId);
  },
};
