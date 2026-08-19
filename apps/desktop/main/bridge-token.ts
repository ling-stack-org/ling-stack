import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MINIMUM_TOKEN_LENGTH = 32;
const inFlightLoads = new Map<string, Promise<string>>();

export function loadOrCreateDesktopBridgeToken(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  const inFlight = inFlightLoads.get(resolvedPath);
  if (inFlight) {
    return inFlight;
  }

  const load = loadOrCreateDesktopBridgeTokenFile(resolvedPath);
  inFlightLoads.set(resolvedPath, load);
  void load.then(
    () => clearInFlightLoad(resolvedPath, load),
    () => clearInFlightLoad(resolvedPath, load),
  );
  return load;
}

async function loadOrCreateDesktopBridgeTokenFile(filePath: string): Promise<string> {
  const existing = await readDesktopBridgeToken(filePath);
  if (existing.kind === "valid") {
    const verified = await secureAndReadDesktopBridgeToken(filePath);
    if (verified) {
      return verified;
    }
  }

  await mkdir(dirname(filePath), { recursive: true });
  if (existing.kind === "missing") {
    const token = createDesktopBridgeToken();
    try {
      await writeFile(filePath, `${token}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return await requireValidDesktopBridgeToken(filePath);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const concurrentToken = await secureAndReadDesktopBridgeToken(filePath);
      if (concurrentToken) {
        return concurrentToken;
      }
    }
  }

  await replaceInvalidDesktopBridgeToken(filePath);
  return await requireValidDesktopBridgeToken(filePath);
}

async function replaceInvalidDesktopBridgeToken(filePath: string): Promise<void> {
  // Another process may have published a valid replacement after the initial
  // read classified this path as invalid. Re-check before claiming the path;
  // otherwise a late contender could quarantine the already-published token
  // and publish a second credential.
  const current = await readDesktopBridgeToken(filePath);
  if (current.kind === "valid") {
    return;
  }
  const quarantinePath = createQuarantineTokenPath(filePath);
  const token = createDesktopBridgeToken();
  let quarantined = false;
  try {
    // Claim the invalid publication with one atomic rename. Only one process
    // can move the old path; every other process then races to create the
    // missing target with O_EXCL and adopts whichever token wins. This avoids
    // two independent atomic replacements publishing different credentials.
    try {
      await rename(filePath, quarantinePath);
      quarantined = true;
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
    try {
      await writeFile(filePath, `${token}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
  } finally {
    if (quarantined) {
      await rm(quarantinePath, { force: true }).catch(() => undefined);
    }
  }
}

async function readDesktopBridgeToken(filePath: string): Promise<DesktopBridgeTokenRead> {
  try {
    const token = (await readFile(filePath, "utf8")).trim();
    return isValidDesktopBridgeToken(token) ? { kind: "valid", token } : { kind: "invalid" };
  } catch (error) {
    if (isMissingFile(error)) {
      return { kind: "missing" };
    }
    throw error;
  }
}

async function secureAndReadDesktopBridgeToken(filePath: string): Promise<string | undefined> {
  try {
    if (process.platform !== "win32") {
      await chmod(filePath, 0o600);
    }
    const token = (await readFile(filePath, "utf8")).trim();
    return isValidDesktopBridgeToken(token) ? token : undefined;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

async function requireValidDesktopBridgeToken(filePath: string): Promise<string> {
  const token = await secureAndReadDesktopBridgeToken(filePath);
  if (!token) {
    throw new Error(`Desktop bridge token at ${filePath} is invalid after publication`);
  }
  return token;
}

function createDesktopBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

function createQuarantineTokenPath(filePath: string): string {
  const suffix = randomBytes(12).toString("hex");
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${suffix}.invalid`);
}

function isValidDesktopBridgeToken(token: string): boolean {
  return token.length >= MINIMUM_TOKEN_LENGTH;
}

function clearInFlightLoad(filePath: string, load: Promise<string>): void {
  if (inFlightLoads.get(filePath) === load) {
    inFlightLoads.delete(filePath);
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

type DesktopBridgeTokenRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; token: string };
