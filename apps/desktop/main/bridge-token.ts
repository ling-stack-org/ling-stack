import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadOrCreateDesktopBridgeToken(filePath: string): Promise<string> {
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  await mkdir(dirname(filePath), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(filePath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    return (await readFile(filePath, "utf8")).trim();
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
