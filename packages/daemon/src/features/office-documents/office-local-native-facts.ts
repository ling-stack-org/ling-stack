import { createHash } from "node:crypto";
import { types } from "node:util";
import { validateOfficeNativeResultFactsV2, type HostOfficeNativeResultFactsV2 } from "@ling-stack/core";

const liveOnlyKeys = new Set(["session", "stageParent", "destinationParent", "capability", "bytes", "publicationFiles"]);
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FACT_NODES = 200_000;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const fail = (): never => { throw new Error("office_local_native_packet_invalid"); };

/** Intrinsic backing span, not shadowable Buffer.length/buffer/byteOffset properties. */
function payloadSpan(value: unknown): Uint8Array {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Buffer.isBuffer(value)) return fail();
  const length = Reflect.apply(byteLengthGetter, value, []), offset = Reflect.apply(byteOffsetGetter, value, []),
    backing = Reflect.apply(bufferGetter, value, []);
  if (!Number.isSafeInteger(length) || length > MAX_BYTES || !(backing instanceof ArrayBuffer)) return fail();
  return new Uint8Array(backing, offset, length);
}

export interface OfficeLocalNativePacketProjection {
  readonly facts: HostOfficeNativeResultFactsV2;
  /** Digest of this returned Buffer, never a supplied digest or a cached read. */
  readonly readbackBytes?: { readonly bytesSha256: string; readonly sizeBytes: number };
  readonly publicationBytes?: readonly {
    readonly originalLifetimeId: string; readonly observedLifetimeId: string;
    readonly bytesSha256: string; readonly sizeBytes: number;
  }[];
}

/**
 * Copy only data properties before Core validation. A malformed native reply
 * must not execute an accessor, serialize an opaque cap, or grow without bound.
 * This is a factual projection only; it issues no session, ticket or receipt.
 */
function copyFacts(value: unknown, budget: { nodes: number }, ancestors: Set<object>, depth = 0): unknown {
  if (++budget.nodes > MAX_FACT_NODES || depth > 32) return fail();
  if (typeof value === "string") return value.length <= 4096 ? value : fail();
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fail();
  if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) return fail();
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)
    && (array || Object.getPrototypeOf(value) !== null)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) return fail();
  if (array && (!descriptors.length || !Object.hasOwn(descriptors.length, "value")
    || !Number.isSafeInteger(descriptors.length.value) || descriptors.length.value > 4096)) return fail();
  const output: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
  ancestors.add(value);
  try {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!Object.hasOwn(descriptor, "value") || (array && key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key))) return fail();
      if (array && key === "length") continue;
      Object.defineProperty(output, key, { value: copyFacts(descriptor.value, budget, ancestors, depth + 1),
        enumerable: true, writable: false, configurable: false });
    }
    if (array && (output as unknown[]).length !== descriptors.length!.value) return fail();
    return Object.freeze(output);
  } finally { ancestors.delete(value); }
}

/**
 * Latch a returned N-API packet's immutable facts and hash its actual read bytes.
 * Aggregate `success:false` remains a normal returned packet with its errno and
 * partial trace. Live caps/payloads never reach SQLite or a public facts getter.
 */
export function projectOfficeLocalNativePacket(raw: unknown): OfficeLocalNativePacketProjection {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) return fail();
  const history: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, "value")) return fail();
    if (!liveOnlyKeys.has(key)) Object.defineProperty(history, key, { value: descriptor.value, enumerable: true });
  }
  const facts = validateOfficeNativeResultFactsV2(copyFacts(history, { nodes: 0 }, new Set()));
  const bytes = descriptors.bytes?.value;
  let readbackBytes: OfficeLocalNativePacketProjection["readbackBytes"];
  if (!facts.readback?.success) {
    if (Object.hasOwn(descriptors, "bytes")) return fail();
  } else {
    const payload = payloadSpan(bytes);
    if (String(payload.byteLength) !== facts.readback.bytesRead) return fail();
    // Hash synchronously while this original reply is retained. Nothing stores
    // payload bytes or provides a second read/capability to a later consumer.
    readbackBytes = Object.freeze({ bytesSha256: createHash("sha256").update(payload).digest("hex"), sizeBytes: payload.byteLength });
  }
  let publicationBytes: OfficeLocalNativePacketProjection["publicationBytes"];
  if (!facts.publication?.success) {
    if (Object.hasOwn(descriptors, "publicationFiles")) return fail();
  } else {
    const files = descriptors.publicationFiles?.value;
    if (types.isProxy(files) || !Array.isArray(files) || Object.getPrototypeOf(files) !== Array.prototype) return fail();
    const fileDescriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(files as object), length = fileDescriptors.length?.value,
      entries = facts.publication.entries.filter(entry => entry.readback);
    if (!Number.isSafeInteger(length) || length > 128 || length !== entries.length
      || Reflect.ownKeys(fileDescriptors).length !== length + 1) return fail();
    const hashes: NonNullable<OfficeLocalNativePacketProjection["publicationBytes"]>[number][] = [];
    let total = 0;
    for (let index = 0; index < length; index++) {
      const slot = fileDescriptors[String(index)];
      if (!slot || !Object.hasOwn(slot, "value")) return fail();
      const file: unknown = slot.value;
      if (!file || typeof file !== "object" || types.isProxy(file) || Object.getPrototypeOf(file) !== Object.prototype) return fail();
      const fields = Object.getOwnPropertyDescriptors(file), expected = entries[index]!;
      if (Reflect.ownKeys(fields).length !== 3 || ["originalLifetimeId", "observedLifetimeId", "bytes"].some(key =>
        !fields[key] || !Object.hasOwn(fields[key], "value"))
        || fields.originalLifetimeId!.value !== expected.originalLifetimeId
        || fields.observedLifetimeId!.value !== expected.observedLifetimeId) return fail();
      const payload = payloadSpan(fields.bytes!.value);
      if (String(payload.byteLength) !== expected.readback!.bytesRead) return fail();
      total += payload.byteLength;
      if (total > MAX_BYTES) return fail();
      hashes.push(Object.freeze({ originalLifetimeId: fields.originalLifetimeId!.value, observedLifetimeId: fields.observedLifetimeId!.value,
        bytesSha256: createHash("sha256").update(payload).digest("hex"), sizeBytes: payload.byteLength }));
    }
    if (String(total) !== facts.publication.expectedBytes) return fail();
    publicationBytes = Object.freeze(hashes);
  }
  return Object.freeze({ facts, ...(readbackBytes ? { readbackBytes } : {}), ...(publicationBytes ? { publicationBytes } : {}) });
}
