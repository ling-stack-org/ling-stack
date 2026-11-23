import { lingDeviceTransport } from "../../modules/ling-device-transport";
import type { UsbModbusBridge } from "../device/usb-modbus";

const module = lingDeviceTransport;

export const nativeUsbModbus: UsbModbusBridge | undefined = module?.listUsbModbusPorts && module.authorizeUsbModbusPort
  && module.reserveUsbModbusPort && module.readUsbModbusRegisters && module.releaseUsbModbusPort
  ? {
    list: module.listUsbModbusPorts.bind(module),
    async authorize(port) {
      await module.authorizeUsbModbusPort!(port.portId, port.vendorId, port.productId);
    },
    async reserve(port) {
      const { sessionId, identity, stableIdentity } = await module.reserveUsbModbusPort!(port.portId, port.vendorId, port.productId);
      return {
        identity, stableIdentity,
        read: (input, hex) => module.readUsbModbusRegisters!(sessionId, input.baudRate, input.parity, input.stopBits, hex),
        close: () => module.releaseUsbModbusPort!(sessionId),
      };
    },
  }
  : undefined;
