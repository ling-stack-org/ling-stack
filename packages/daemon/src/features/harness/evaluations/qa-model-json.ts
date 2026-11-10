/** Bounded own-data copies for QA-only model preparation and response parsing. */
export function copyQaModelJson(value: unknown, maximumBytes = 32_768): unknown {
  let nodes = 0;
  let characters = 0;
  const seen = new Set<object>();
  const invalid = (): never => { throw new Error("evaluation_qa_json_invalid"); };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 4_096 || depth > 24) invalid();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      characters += item.length;
      if (characters > maximumBytes) invalid();
      return item;
    }
    if (!item || typeof item !== "object" || seen.has(item)) return invalid();
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    let result: unknown;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 1_024
        || keys.length !== item.length + 1) invalid();
      const output: unknown[] = [];
      for (let index = 0; index < item.length; index += 1) {
        const field = Object.getOwnPropertyDescriptor(item, String(index));
        if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return invalid();
        output.push(visit(field.value, depth + 1));
      }
      result = Object.freeze(output);
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || keys.length > 64) invalid();
      const output: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== "string") throw new Error("evaluation_qa_json_invalid");
        const field = Object.getOwnPropertyDescriptor(item, key);
        if (key.length > 100 || !field || !Object.hasOwn(field, "value") || !field.enumerable) return invalid();
        characters += key.length;
        if (characters > maximumBytes) invalid();
        Object.defineProperty(output, key, { value: visit(field.value, depth + 1), enumerable: true });
      }
      result = Object.freeze(output);
    }
    seen.delete(item);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumBytes) invalid();
  return result;
}

/** Require a fixed schema after a safe copy; no getter, prototype or toJSON execution. */
export function qaModelRecord(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const copied = copyQaModelJson(value, 65_536);
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) throw new Error("evaluation_qa_schema_invalid");
  const record = copied as Record<string, unknown>;
  const allowed = [...fields, ...optional];
  if (Object.keys(record).some(key => !allowed.includes(key))
    || fields.some(key => !optional.includes(key) && !Object.hasOwn(record, key))) {
    throw new Error("evaluation_qa_schema_invalid");
  }
  return record;
}

export function qaModelString(value: unknown, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error("evaluation_qa_schema_invalid");
  }
  return value;
}
