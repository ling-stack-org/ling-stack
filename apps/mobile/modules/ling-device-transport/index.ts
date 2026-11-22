import { requireOptionalNativeModule } from "expo";
import type { AndroidApkIdentityV1, LinuxSshReadOperation, LinuxSshReadResult } from "@ling-stack/contracts";
export type { LinuxSshReadOperation } from "@ling-stack/contracts";

interface LingDeviceTransportNativeModule {
  inspectAndroidApk?(fileUri: string): Promise<AndroidApkIdentityV1>;
  reserve(): string;
  connect(
    sessionId: string, host: string, port: number, user: string, fingerprintHex: string, password: string,
  ): Promise<void>;
  read(sessionId: string, operation: LinuxSshReadOperation, argument: string): Promise<LinuxSshReadResult>;
  close(sessionId: string): void;
}

export const lingDeviceTransport = requireOptionalNativeModule<LingDeviceTransportNativeModule>("LingDeviceTransport");
