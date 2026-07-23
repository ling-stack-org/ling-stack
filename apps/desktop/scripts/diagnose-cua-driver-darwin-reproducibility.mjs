#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  summarizeCuaDriverMachOReproducibility,
} from "./cua-driver-macho-identity-normalizer.mjs";
import {
  readBoundedFileSnapshot,
} from "./cua-driver-package-staging-files.mjs";

const ARCHIVE_MAGIC = "!<arch>\n";
const ARCHIVE_HEADER_BYTES = 60;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 4_096;
const MAX_REPORTED_DIFFERENCES = 64;
const TARGETS = ["aarch64-apple-darwin"];
const SWIFT_ARCHIVE_PATTERN = /^lib(?:apple_cf|screencapturekit)-[0-9a-f]+\.rlib$/u;

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const leftRoot = resolveRequired(args["left-work-dir"], "--left-work-dir");
  const rightRoot = resolveRequired(args["right-work-dir"], "--right-work-dir");
  const targets = [];
  for (const target of TARGETS) {
    targets.push(await compareTarget({ leftRoot, rightRoot, target }));
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    equal: targets.every((entry) => entry.equal),
    targets,
  }, null, 2)}\n`);
}

async function compareTarget({ leftRoot, rightRoot, target }) {
  const binaryRelativePath = join("cargo-target", target, "release", "cua-driver");
  const [leftBinary, rightBinary] = await Promise.all([
    readRegularBoundedFile(join(leftRoot, binaryRelativePath), MAX_BINARY_BYTES, `${target} left binary`),
    readRegularBoundedFile(join(rightRoot, binaryRelativePath), MAX_BINARY_BYTES, `${target} right binary`),
  ]);
  const leftSummary = summarizeCuaDriverMachOReproducibility(leftBinary);
  const rightSummary = summarizeCuaDriverMachOReproducibility(rightBinary);
  const binary = {
    equal: leftSummary.sourceSha256 === rightSummary.sourceSha256,
    leftSourceSha256: leftSummary.sourceSha256,
    rightSourceSha256: rightSummary.sourceSha256,
    loadCommands: compareScalar(
      leftSummary.loadCommandsSha256,
      rightSummary.loadCommandsSha256,
    ),
    segments: compareNamedDigests(leftSummary.segments, rightSummary.segments),
    sections: compareNamedDigests(leftSummary.sections, rightSummary.sections),
  };
  const archives = await compareSwiftArchives({ leftRoot, rightRoot, target });
  return {
    target,
    equal: binary.equal && archives.every((entry) => entry.equal),
    binary,
    swiftArchives: archives,
  };
}

async function compareSwiftArchives({ leftRoot, rightRoot, target }) {
  const leftDeps = join(leftRoot, "cargo-target", target, "release", "deps");
  const rightDeps = join(rightRoot, "cargo-target", target, "release", "deps");
  const [leftNames, rightNames] = await Promise.all([
    listSwiftArchives(leftDeps),
    listSwiftArchives(rightDeps),
  ]);
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) {
    throw new Error(`${target} Swift archive inventory differs: left=${JSON.stringify(leftNames)} right=${JSON.stringify(rightNames)}`);
  }
  const compared = [];
  for (const name of leftNames) {
    const [leftBytes, rightBytes] = await Promise.all([
      readRegularBoundedFile(join(leftDeps, name), MAX_ARCHIVE_BYTES, `${target} left ${name}`),
      readRegularBoundedFile(join(rightDeps, name), MAX_ARCHIVE_BYTES, `${target} right ${name}`),
    ]);
    const leftSummary = summarizeArchive(leftBytes);
    const rightSummary = summarizeArchive(rightBytes);
    compared.push({
      archive: canonicalArchiveName(name),
      equal: leftSummary.sha256 === rightSummary.sha256,
      leftSha256: leftSummary.sha256,
      rightSha256: rightSummary.sha256,
      canonicalMembers: compareScalar(
        leftSummary.canonicalMembersSha256,
        rightSummary.canonicalMembersSha256,
      ),
      memberDifferences: compareNamedDigests(
        leftSummary.members,
        rightSummary.members,
      ),
    });
  }
  return compared;
}

export function summarizeArchive(input) {
  if (!Buffer.isBuffer(input)
    || input.subarray(0, ARCHIVE_MAGIC.length).toString("ascii") !== ARCHIVE_MAGIC) {
    throw new Error("reproducibility diagnostic archive magic mismatch");
  }
  const occurrences = new Map();
  const members = [];
  let cursor = ARCHIVE_MAGIC.length;
  while (cursor < input.length) {
    if (members.length >= MAX_ARCHIVE_MEMBERS) {
      throw new Error("reproducibility diagnostic archive member limit exceeded");
    }
    if (cursor + ARCHIVE_HEADER_BYTES > input.length) {
      throw new Error("reproducibility diagnostic archive header is truncated");
    }
    const header = input.subarray(cursor, cursor + ARCHIVE_HEADER_BYTES);
    if (header.subarray(58, 60).toString("ascii") !== "`\n") {
      throw new Error("reproducibility diagnostic archive trailer mismatch");
    }
    const memberSize = parseArchiveDecimal(header.subarray(48, 58));
    const memberStart = cursor + ARCHIVE_HEADER_BYTES;
    const memberEnd = memberStart + memberSize;
    if (memberEnd > input.length) {
      throw new Error("reproducibility diagnostic archive payload is truncated");
    }
    const rawName = header.subarray(0, 16).toString("ascii").trim();
    let name = rawName;
    let payloadStart = memberStart;
    if (rawName.startsWith("#1/")) {
      const nameBytes = Number.parseInt(rawName.slice(3), 10);
      if (!Number.isSafeInteger(nameBytes) || nameBytes < 1 || nameBytes > memberSize) {
        throw new Error("reproducibility diagnostic BSD archive name is invalid");
      }
      name = input.subarray(memberStart, memberStart + nameBytes)
        .toString("utf8")
        .replace(/\0+$/gu, "");
      payloadStart += nameBytes;
    } else if (name.endsWith("/") && name !== "/" && name !== "//") {
      name = name.slice(0, -1);
    }
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    const payload = input.subarray(payloadStart, memberEnd);
    members.push(Object.freeze({
      name: `${name}#${occurrence}`,
      size: payload.length,
      sha256: sha256(payload),
    }));
    cursor = memberEnd + (memberSize % 2);
  }
  if (cursor !== input.length) {
    throw new Error("reproducibility diagnostic archive alignment mismatch");
  }
  return Object.freeze({
    sha256: sha256(input),
    canonicalMembersSha256: sha256(Buffer.from(JSON.stringify(members))),
    members: Object.freeze(members),
  });
}

function compareNamedDigests(leftEntries, rightEntries) {
  const left = new Map(leftEntries.map((entry) => [entry.name, entry]));
  const right = new Map(rightEntries.map((entry) => [entry.name, entry]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const differences = names.flatMap((name) => {
    const leftEntry = left.get(name);
    const rightEntry = right.get(name);
    if (leftEntry?.sha256 === rightEntry?.sha256
      && leftEntry?.size === rightEntry?.size
      && leftEntry?.offset === rightEntry?.offset) {
      return [];
    }
    return [{ name, left: leftEntry ?? null, right: rightEntry ?? null }];
  });
  return {
    count: differences.length,
    truncated: differences.length > MAX_REPORTED_DIFFERENCES,
    entries: differences.slice(0, MAX_REPORTED_DIFFERENCES),
  };
}

function compareScalar(left, right) {
  return { equal: left === right, left, right };
}

async function listSwiftArchives(root) {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && SWIFT_ARCHIVE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length !== 2) {
    throw new Error(`reproducibility diagnostic Swift archive inventory mismatch: ${JSON.stringify(names)}`);
  }
  return names;
}

async function readRegularBoundedFile(path, maximumBytes, label) {
  return (await readBoundedFileSnapshot(path, maximumBytes, label)).bytes;
}

function canonicalArchiveName(name) {
  return name.replace(/-[0-9a-f]+\.rlib$/u, ".rlib");
}

function parseArchiveDecimal(value) {
  const text = value.toString("ascii").trim();
  if (!/^[0-9]+$/u.test(text)) {
    throw new Error("reproducibility diagnostic archive size is invalid");
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("reproducibility diagnostic archive size is out of range");
  }
  return parsed;
}

function resolveRequired(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return resolve(value);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    result[token.slice(2)] = value;
    index += 1;
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
