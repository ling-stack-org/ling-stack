import type { JsonValue } from "./device.js";

const types = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
const keywords = new Set([
  "type", "properties", "required", "additionalProperties", "items",
  "minimum", "maximum", "enum", "title", "description",
]);

type Scalar = string | number | boolean | null;

export interface DeviceCapabilitySchemaV1 {
  readonly type?: (typeof types)[number];
  readonly properties?: Readonly<Record<string, DeviceCapabilitySchemaV1>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: DeviceCapabilitySchemaV1;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly Scalar[];
  readonly title?: string;
  readonly description?: string;
}

/** The V1 subset used by device adapters on both Daemon and Mobile. */
export function isDeviceCapabilitySchemaV1(value: unknown): value is DeviceCapabilitySchemaV1 {
  return isSchema(value, 0);
}

function isSchema(value: unknown, depth: number): value is DeviceCapabilitySchemaV1 {
  if (depth > 16 || !isRecord(value) || Object.keys(value).some(key => !keywords.has(key))) return false;
  const { type, properties, required, additionalProperties, items, minimum, maximum, title, description } = value;
  return (type === undefined || types.some(candidate => candidate === type))
    && (properties === undefined || (isRecord(properties) && Object.values(properties).every(child => isSchema(child, depth + 1))))
    && (required === undefined || (Array.isArray(required) && required.every(key => typeof key === "string")
      && new Set(required).size === required.length))
    && (additionalProperties === undefined || typeof additionalProperties === "boolean")
    && (items === undefined || isSchema(items, depth + 1))
    && (minimum === undefined || isFiniteNumber(minimum))
    && (maximum === undefined || isFiniteNumber(maximum))
    && (!isFiniteNumber(minimum) || !isFiniteNumber(maximum) || minimum <= maximum)
    && (value.enum === undefined || (Array.isArray(value.enum) && value.enum.length > 0
      && value.enum.every(isScalar) && new Set(value.enum).size === value.enum.length))
    && (title === undefined || typeof title === "string")
    && (description === undefined || typeof description === "string");
}

export function matchesDeviceCapabilitySchemaV1(value: JsonValue, schema: JsonValue): boolean {
  return isDeviceCapabilitySchemaV1(schema) && matches(value, schema);
}

function matches(value: JsonValue, schema: DeviceCapabilitySchemaV1): boolean {
  if (schema.type !== undefined && !matchesType(value, schema.type)) return false;
  if (schema.enum && !schema.enum.some(candidate => candidate === value)) return false;
  if (typeof value === "number") return value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (Array.isArray(value)) return !schema.items || value.every(item => matches(item, schema.items!));
  if (!isRecord(value)) return true;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  for (const [key, field] of Object.entries(value as Readonly<Record<string, JsonValue>>)) {
    if (schema.properties && Object.hasOwn(schema.properties, key)) {
      if (!matches(field, schema.properties[key]!)) return false;
    } else if (schema.additionalProperties === false) return false;
  }
  return true;
}

function matchesType(value: JsonValue, type: NonNullable<DeviceCapabilitySchemaV1["type"]>): boolean {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isSafeInteger(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}
