import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";

export const LING_ICON_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 128, 256]);

export function inspectIcoFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) {
    throw new Error("ICO source is missing or truncated");
  }
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("ICO source has an invalid header");
  }
  const count = buffer.readUInt16LE(4);
  if (buffer.length < 6 + count * 16) {
    throw new Error("ICO source directory is truncated");
  }

  const frames = Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    const bitCount = buffer.readUInt16LE(offset + 6);
    const dataSize = buffer.readUInt32LE(offset + 8);
    const dataOffset = buffer.readUInt32LE(offset + 12);
    if (buffer[offset + 3] !== 0 || dataSize === 0 || dataOffset + dataSize > buffer.length) {
      throw new Error(`ICO frame ${index} has invalid metadata`);
    }
    const data = buffer.subarray(dataOffset, dataOffset + dataSize);
    return { width, height, bitCount, dataSize, sha256: sha256(data), data };
  });
  const keys = frames.map(frameKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("ICO source contains duplicate frame identities");
  }
  return frames;
}

export function verifyWindowsExecutableIcon(sourceIco, executable, label = "Windows executable") {
  const sourceFrames = inspectIcoFrames(sourceIco);
  const sourceByKey = new Map(sourceFrames.map((frame) => [frameKey(frame), frame]));
  const parsedExecutable = NtExecutable.from(executable, { ignoreCert: true });
  const resources = NtExecutableResource.from(parsedExecutable);
  const requestedExecutionLevel = inspectRequestedExecutionLevel(resources.entries, label);
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  if (groups.length !== 1) {
    throw new Error(`${label} must contain exactly one icon group, found ${groups.length}`);
  }

  const group = groups[0];
  const packagedFrames = group.icons.map((icon) => {
    const width = icon.width || 256;
    const height = icon.height || 256;
    const key = frameKey({ width, height, bitCount: icon.bitCount });
    const sourceFrame = sourceByKey.get(key);
    if (!sourceFrame) {
      throw new Error(`${label} contains unexpected icon frame ${key}`);
    }
    const resource = resources.entries.find((entry) => (
      entry.type === 3 && entry.id === icon.iconID && entry.lang === group.lang
    ));
    if (!resource) {
      throw new Error(`${label} is missing RT_ICON ${icon.iconID} for ${key}`);
    }
    const data = Buffer.from(resource.bin);
    if (data.length !== icon.dataSize || !data.equals(sourceFrame.data)) {
      throw new Error(`${label} icon payload differs from the committed source for ${key}`);
    }
    return { width, height, bitCount: icon.bitCount, dataSize: data.length, sha256: sha256(data) };
  });

  if (packagedFrames.length !== sourceFrames.length) {
    throw new Error(
      `${label} icon frame count differs from the committed source: ${packagedFrames.length} != ${sourceFrames.length}`,
    );
  }
  const packagedKeys = packagedFrames.map(frameKey).sort();
  const sourceKeys = sourceFrames.map(frameKey).sort();
  if (packagedKeys.some((key, index) => key !== sourceKeys[index])) {
    throw new Error(`${label} icon frame set differs from the committed source`);
  }
  return {
    label,
    iconGroupId: group.id,
    language: group.lang,
    requestedExecutionLevel,
    frames: packagedFrames,
  };
}

function inspectRequestedExecutionLevel(entries, label) {
  const manifests = entries.filter((entry) => entry.type === 24);
  if (manifests.length !== 1) {
    throw new Error(`${label} must contain exactly one RT_MANIFEST, found ${manifests.length}`);
  }
  const manifest = Buffer.from(manifests[0].bin).toString("utf8").replaceAll("\0", "");
  const requestedExecutionLevel = /<requestedExecutionLevel\b([^>]*)\/?\s*>/iu.exec(manifest);
  if (!requestedExecutionLevel) {
    throw new Error(`${label} manifest is missing requestedExecutionLevel`);
  }
  const attributes = requestedExecutionLevel[1];
  const level = /\blevel\s*=\s*["']([^"']+)["']/iu.exec(attributes)?.[1];
  const uiAccess = /\buiAccess\s*=\s*["']([^"']+)["']/iu.exec(attributes)?.[1];
  if (level !== "asInvoker" || uiAccess !== "false") {
    throw new Error(
      `${label} must request asInvoker with uiAccess=false, found level=${level ?? "<missing>"} uiAccess=${uiAccess ?? "<missing>"}`,
    );
  }
  return { level, uiAccess };
}

function frameKey({ width, height, bitCount }) {
  return `${width}x${height}@${bitCount}`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const [sourcePath, ...executablePaths] = process.argv.slice(2);
  if (!sourcePath || executablePaths.length === 0) {
    throw new Error(
      "Usage: node verify-windows-app-icons.mjs <source.ico> <application.exe> [installer.exe ...]",
    );
  }
  const sourceIco = await readFile(resolve(sourcePath));
  const reports = [];
  for (const executablePath of executablePaths) {
    const resolvedPath = resolve(executablePath);
    reports.push(verifyWindowsExecutableIcon(
      sourceIco,
      await readFile(resolvedPath),
      basename(resolvedPath),
    ));
  }
  process.stdout.write(`${JSON.stringify({ source: resolve(sourcePath), reports }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
