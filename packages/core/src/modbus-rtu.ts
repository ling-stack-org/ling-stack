import type { HardwareProtocolDecodedFrameV1, HardwareProtocolFrameV1 } from "@ling-stack/contracts";

import type { HardwareProtocolCodec } from "./device-protocol.js";

export const modbusRtuRegisterCodec: HardwareProtocolCodec = {
  manifest: {
    codecId: "modbus-rtu-registers",
    version: "1.0.0",
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

export function encodeModbusRtuRegisterRead(input: {
  readonly unitAddress: number;
  readonly table: "holding" | "input";
  readonly startAddress: number;
  readonly quantity: number;
}): Uint8Array {
  const { unitAddress, table, startAddress, quantity } = input;
  if (!validUnitAddress(unitAddress) || !validRegisterRange(startAddress, quantity) || (table !== "holding" && table !== "input")) {
    throw new RangeError("Modbus RTU register read address or quantity is invalid");
  }
  const data = Uint8Array.of(unitAddress, table === "holding" ? 3 : 4, startAddress >> 8, startAddress & 0xff, quantity >> 8, quantity & 0xff);
  const checksum = crc16(data);
  return Uint8Array.of(...data, checksum & 0xff, checksum >> 8);
}

export function decodeModbusRtuRegisterFrame(
  bytes: Uint8Array, direction: HardwareProtocolFrameV1["direction"],
): Omit<HardwareProtocolDecodedFrameV1, "sequence"> {
  if (bytes.length < 4 || bytes.length > 256) {
    return { messageType: "malformed_frame", fields: { frameLength: bytes.length }, checksumValid: false };
  }
  const unitAddress = bytes[0]!;
  const functionCode = bytes[1]!;
  const fields = { unitAddress, functionCode };
  const checksum = bytes[bytes.length - 2]! | (bytes[bytes.length - 1]! << 8);
  if (crc16(bytes.subarray(0, -2)) !== checksum) return { messageType: "invalid_checksum", fields, checksumValid: false };
  const malformed = { messageType: "malformed_frame", fields, checksumValid: true };
  if (!validUnitAddress(unitAddress)) return malformed;
  if (direction === "rx" && (functionCode & 0x80) !== 0) {
    return bytes.length === 5
      ? { messageType: "exception_response", fields: { ...fields, functionCode: functionCode & 0x7f, exceptionCode: bytes[2]! }, checksumValid: true }
      : malformed;
  }
  if (functionCode !== 3 && functionCode !== 4) {
    return { messageType: "unsupported_function", fields, checksumValid: true };
  }
  const table = functionCode === 3 ? "holding" : "input";
  if (direction === "tx") {
    if (bytes.length !== 8) return malformed;
    const startAddress = (bytes[2]! << 8) | bytes[3]!;
    const quantity = (bytes[4]! << 8) | bytes[5]!;
    if (!validRegisterRange(startAddress, quantity)) return malformed;
    return { messageType: "read_registers_request", fields: { ...fields, table, startAddress, quantity }, checksumValid: true };
  }
  const byteCount = bytes[2]!;
  if (byteCount < 2 || byteCount > 250 || byteCount % 2 !== 0 || bytes.length !== byteCount + 5) return malformed;
  const quantity = byteCount / 2;
  const registers: Record<string, number> = {};
  for (let index = 0; index < quantity; index += 1) {
    const offset = 3 + index * 2;
    registers[`register${index}`] = (bytes[offset]! << 8) | bytes[offset + 1]!;
  }
  return { messageType: "read_registers_response", fields: { ...fields, table, quantity, ...registers }, checksumValid: true };
}

function validUnitAddress(address: number): boolean {
  return Number.isInteger(address) && address >= 1 && address <= 247;
}

function validRegisterRange(startAddress: number, quantity: number): boolean {
  return Number.isInteger(startAddress) && startAddress >= 0 && Number.isInteger(quantity)
    && quantity >= 1 && quantity <= 125 && startAddress + quantity <= 65_536;
}

function crc16(bytes: Uint8Array): number {
  let checksum = 0xffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const carry = (checksum & 1) !== 0;
      checksum >>>= 1;
      if (carry) checksum ^= 0xa001;
    }
  }
  return checksum;
}
