export function readFirstDataString(dataSources: readonly unknown[], keys: readonly string[]): string {
  for (const data of dataSources) {
    for (const key of keys) {
      const value = readDataString(data, key);
      if (value) {
        return value;
      }
    }
  }
  return "";
}

export function readFirstDataScalarString(dataSources: readonly unknown[], keys: readonly string[]): string {
  for (const data of dataSources) {
    for (const key of keys) {
      const value = readDataField(data, key);
      if (typeof value === "string" && value) {
        return value;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
    }
  }
  return "";
}

export function readDeepDataScalarString(data: unknown, keys: readonly string[]): string {
  for (const source of readDataContainers(data)) {
    for (const key of keys) {
      const value = readDataField(source, key);
      if (typeof value === "string" && value) {
        return value;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
    }
  }
  return "";
}

export function readDeepDataPreview(data: unknown, keys: readonly string[]): string {
  for (const source of readDataContainers(data)) {
    for (const key of keys) {
      const value = readDataField(source, key);
      const preview = formatUnknownPreview(value, 220);
      if (preview) {
        return preview;
      }
    }
  }
  return "";
}

export function readDataContainers(data: unknown): readonly unknown[] {
  return [
    data,
    readDataField(data, "args"),
    readDataField(data, "input"),
    readDataField(data, "payload"),
    readDataField(data, "result"),
    readDataField(data, "partialResult"),
  ].filter((value) => value !== undefined && value !== null);
}

export function readDataString(data: unknown, key: string): string {
  if (typeof data === "object" && data !== null && key in data) {
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

export function readDataBoolean(data: unknown, key: string): boolean {
  if (typeof data === "object" && data !== null && key in data) {
    return (data as Record<string, unknown>)[key] === true;
  }
  return false;
}

export function readDataField(data: unknown, key: string): unknown {
  if (typeof data === "object" && data !== null && key in data) {
    return (data as Record<string, unknown>)[key];
  }
  return undefined;
}

export function formatEventPreview(data: unknown): string {
  const preview = readDeepDataPreview(data, ["message", "error", "detail", "reason", "command", "text", "result", "partialResult"]);
  if (preview) {
    return preview;
  }
  return formatUnknownPreview(data, 160);
}

export function formatUnknownPreview(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return truncatePreview(value, maxLength);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return truncatePreview(JSON.stringify(value), maxLength);
  } catch {
    return truncatePreview(String(value), maxLength);
  }
}

export function truncatePreview(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

export function formatEventData(data: unknown): string {
  if (typeof data === "object" && data !== null && "text" in data) {
    const value = (data as { text?: unknown }).text;
    if (typeof value === "string") {
      return value.length > 240 ? `${value.slice(0, 240)}...` : value;
    }
  }
  return JSON.stringify(data, null, 2);
}
