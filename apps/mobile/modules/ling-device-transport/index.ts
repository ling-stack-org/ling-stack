import { requireOptionalNativeModule } from "expo";

export type LinuxSshReadOperation = "kernel" | "addresses" | "route" | "wifi" | "link" | "dns";

interface LinuxSshNativeModule {
  reserve(): string;
  connect(
    sessionId: string, host: string, port: number, user: string, fingerprintHex: string, password: string,
  ): Promise<void>;
  read(sessionId: string, operation: LinuxSshReadOperation, argument: string): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }>;
  close(sessionId: string): void;
}

export const linuxSshNativeModule = requireOptionalNativeModule<LinuxSshNativeModule>("LingDeviceTransport");
