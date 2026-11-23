import { requireOptionalNativeModule } from "expo";
import type { AndroidApkIdentityV1, LinuxSshReadOperation, LinuxSshReadResult } from "@ling-stack/contracts";
import type { UsbModbusPort, UsbModbusTransfer } from "../../src/device/usb-modbus";
export type { LinuxSshReadOperation } from "@ling-stack/contracts";

interface LingDeviceTransportNativeModule {
  inspectAndroidApk?(fileUri: string): Promise<AndroidApkIdentityV1>;
  reserve(): string;
  connect(
    sessionId: string, host: string, port: number, user: string, fingerprintHex: string, password: string,
  ): Promise<void>;
  read(sessionId: string, operation: LinuxSshReadOperation, argument: string): Promise<LinuxSshReadResult>;
  close(sessionId: string): void;
  listUsbModbusPorts?(): Promise<readonly UsbModbusPort[]>;
  authorizeUsbModbusPort?(portId: string, vendorId: number, productId: number): Promise<void>;
  reserveUsbModbusPort?(portId: string, vendorId: number, productId: number): Promise<{
    readonly sessionId: string; readonly identity: string; readonly stableIdentity: boolean;
  }>;
  readUsbModbusRegisters?(
    sessionId: string, baudRate: number, parity: string, stopBits: number, requestHex: string,
  ): Promise<UsbModbusTransfer>;
  releaseUsbModbusPort?(sessionId: string): void;
}

export const lingDeviceTransport = requireOptionalNativeModule<LingDeviceTransportNativeModule>("LingDeviceTransport");
