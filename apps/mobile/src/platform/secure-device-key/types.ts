import type { RemoteP256PublicJwkV1 } from "@ling-stack/contracts";

export type SecureDeviceKeyBackend = "ios_secure_enclave" | "android_keystore";

export type SecureDeviceKeySecurityLevel =
  | "secure_enclave"
  | "strongbox"
  | "trusted_environment"
  | "unknown_secure"
  | "software";

export interface SecureDeviceKeyInfo {
  readonly keyId: string;
  readonly publicJwk: RemoteP256PublicJwkV1;
  readonly backend: SecureDeviceKeyBackend;
  readonly securityLevel: SecureDeviceKeySecurityLevel;
  readonly hardwareBacked: boolean;
  readonly privateKeyExportable: false;
}

export interface NativeSecureDeviceKeyInfo extends SecureDeviceKeyInfo {}

export interface NativeSecureDeviceKeySignature {
  readonly signatureBase64Url: string;
  readonly encoding: "x962_der";
}

export interface NativeSecureDeviceKeyModule {
  readonly randomBytes: (length: number) => Promise<string>;
  readonly generateOrLoad: (keyId: string) => Promise<NativeSecureDeviceKeyInfo>;
  readonly sign: (keyId: string, messageBase64Url: string) => Promise<NativeSecureDeviceKeySignature>;
  readonly verify: (
    publicJwk: RemoteP256PublicJwkV1,
    messageBase64Url: string,
    derSignatureBase64Url: string,
  ) => Promise<boolean>;
  readonly delete: (keyId: string) => Promise<void>;
}

export interface SecureDeviceKeyAdapter {
  readonly generateOrLoad: (keyId: string) => Promise<SecureDeviceKeyInfo>;
  readonly sign: (keyId: string, message: Uint8Array) => Promise<string>;
  readonly verify: (
    publicJwk: RemoteP256PublicJwkV1,
    message: Uint8Array,
    p1363SignatureBase64Url: string,
  ) => Promise<boolean>;
  readonly delete: (keyId: string) => Promise<void>;
}
