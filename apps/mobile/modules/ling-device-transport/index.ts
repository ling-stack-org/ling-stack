import { requireOptionalNativeModule } from "expo";
import type { AndroidApkIdentityV1, LinuxSshReadOperation, LinuxSshReadResult } from "@ling-stack/contracts";
import type { UsbModbusPort, UsbModbusTransfer } from "../../src/device/usb-modbus";
import type { UsbAndroidDevice, UsbAndroidIdentity, UsbAndroidPackage } from "../../src/device/usb-android";
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
  listUsbAndroidTargets?(): Promise<readonly UsbAndroidDevice[]>;
  authorizeUsbAndroidTarget?(portId: string, vendorId: number, productId: number): Promise<void>;
  reserveUsbAndroidTarget?(portId: string, vendorId: number, productId: number): string;
  connectUsbAndroidTarget?(sessionId: string): Promise<UsbAndroidIdentity>;
  installUsbAndroidApk?(sessionId: string, uri: string, digest: string): Promise<boolean>;
  readUsbAndroidInstalledPackage?(sessionId: string, packageId: string): Promise<UsbAndroidPackage>;
  readUsbAndroidLogs?(sessionId: string, tag: string): Promise<string>;
  releaseUsbAndroidTarget?(sessionId: string): void;
}

export const lingDeviceTransport = requireOptionalNativeModule<LingDeviceTransportNativeModule>("LingDeviceTransport");
