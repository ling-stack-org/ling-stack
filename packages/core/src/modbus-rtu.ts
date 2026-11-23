import { decodeModbusRtuRegisterFrame, MODBUS_RTU_REGISTER_CODEC } from "@ling-stack/contracts";

import type { HardwareProtocolCodec } from "./device-protocol.js";

export const modbusRtuRegisterCodec: HardwareProtocolCodec = {
  manifest: {
    ...MODBUS_RTU_REGISTER_CODEC,
    transport: "rs485",
    messageTypes: [
      "read_registers_request", "read_registers_response", "exception_response",
      "invalid_checksum", "malformed_frame", "unsupported_function",
    ],
    license: "MIT",
  },
  decode(frame) {
    return { sequence: frame.sequence, ...decodeModbusRtuRegisterFrame(Buffer.from(frame.bytesBase64, "base64"), frame.direction) };
  },
};

export { decodeModbusRtuRegisterFrame, encodeModbusRtuRegisterRead } from "@ling-stack/contracts";
