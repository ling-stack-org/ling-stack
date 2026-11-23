import { lingDeviceTransport } from "../../modules/ling-device-transport";
import type { UsbAndroidBridge } from "../device/usb-android";

const native = lingDeviceTransport;
const list = native?.listUsbAndroidTargets?.bind(native);
const authorize = native?.authorizeUsbAndroidTarget?.bind(native);
const reserve = native?.reserveUsbAndroidTarget?.bind(native);
const connect = native?.connectUsbAndroidTarget?.bind(native);
const install = native?.installUsbAndroidApk?.bind(native);
const readPackage = native?.readUsbAndroidInstalledPackage?.bind(native);
const readLogs = native?.readUsbAndroidLogs?.bind(native);
const release = native?.releaseUsbAndroidTarget?.bind(native);

export const nativeUsbAndroid: UsbAndroidBridge | undefined = list && authorize && reserve && connect && install && readPackage && readLogs && release ? {
  list,
  authorize(target) {
    return authorize(target.portId, target.vendorId, target.productId);
  },
  async open(target, signal) {
    if (signal.aborted) throw new Error("usb_connection_failed");
    const id = reserve(target.portId, target.vendorId, target.productId);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", close);
      release(id);
    };
    signal.addEventListener("abort", close, { once: true });
    try {
      const identity = await connect(id);
      if (closed) throw new Error("usb_connection_failed");
      return {
        identity,
        install: (uri, digest) => install(id, uri, digest),
        readPackage: packageId => readPackage(id, packageId),
        readLogs: tag => readLogs(id, tag),
        close,
      };
    } catch (error) {
      close();
      throw error;
    }
  },
} : undefined;
