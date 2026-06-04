import type { IncomingMessage } from "node:http";

export async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required");
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export async function readOptionalJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export function readOptionalIntegerQuery(url: URL, key: string, minValue: number): number | undefined {
  const rawValue = url.searchParams.get(key);
  if (rawValue === null) {
    return undefined;
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < minValue || String(value) !== rawValue) {
    throw new Error(`${key} must be an integer greater than or equal to ${minValue}`);
  }
  return value;
}

export function readOptionalBooleanQuery(url: URL, key: string): boolean | undefined {
  const rawValue = url.searchParams.get(key);
  if (rawValue === null) {
    return undefined;
  }
  if (rawValue !== "true" && rawValue !== "false") {
    throw new Error(`${key} must be true or false`);
  }
  return rawValue === "true";
}
