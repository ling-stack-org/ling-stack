import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const WINDOWS_CUA_DRIVER_RELEASE = Object.freeze({
  repository: "trycua/cua",
  component: "cua-driver-rs",
  version: "0.8.3",
  tag: "cua-driver-rs-v0.8.3",
  assetName: "cua-driver-rs-0.8.3-windows-x86_64.zip",
  assetRoot: "cua-driver-rs-0.8.3-windows-x86_64",
  assetBytes: 10_585_087,
  sha256: "6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0",
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.8.3/cua-driver-rs-0.8.3-windows-x86_64.zip",
});

const EXPECTED_PE_MACHINE = 0x8664;
const EXPECTED_OPTIONAL_HEADER_MAGIC = 0x20b;
const DOWNLOAD_ATTEMPTS = 3;
const CHILD_OUTPUT_LIMIT = 32_768;

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function inspectWindowsX64Pe(buffer, label = "Windows provider binary") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x100) {
    throw new Error(`${label} is too small to be a PE executable`);
  }
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error(`${label} is missing the DOS MZ header`);
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > buffer.length) {
    throw new Error(`${label} has an invalid PE header offset`);
  }
  if (!buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) {
    throw new Error(`${label} is missing the PE signature`);
  }

  const machine = buffer.readUInt16LE(peOffset + 4);
  if (machine !== EXPECTED_PE_MACHINE) {
    throw new Error(
      `${label} must target Windows x86_64 (PE machine 0x8664), found 0x${machine.toString(16).padStart(4, "0")}`,
    );
  }

  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  if (optionalHeaderSize < 112 || optionalHeaderOffset + optionalHeaderSize > buffer.length) {
    throw new Error(`${label} has an invalid PE32+ optional header`);
  }
  const optionalHeaderMagic = buffer.readUInt16LE(optionalHeaderOffset);
  if (optionalHeaderMagic !== EXPECTED_OPTIONAL_HEADER_MAGIC) {
    throw new Error(
      `${label} must be PE32+ (magic 0x20b), found 0x${optionalHeaderMagic.toString(16)}`,
    );
  }

  // The certificate-table directory says whether a signature blob is embedded. It does
  // not establish signer trust; only Get-AuthenticodeSignature on Windows does that.
  const certificateDirectoryOffset = optionalHeaderOffset + 112 + 4 * 8;
  const certificateDirectoryAvailable = optionalHeaderSize >= 112 + 5 * 8;
  const certificateTableOffset = certificateDirectoryAvailable
    ? buffer.readUInt32LE(certificateDirectoryOffset)
    : 0;
  const certificateTableSize = certificateDirectoryAvailable
    ? buffer.readUInt32LE(certificateDirectoryOffset + 4)
    : 0;

  return {
    format: "PE32+",
    machine: "0x8664",
    architecture: "x86_64",
    embeddedCertificateTablePresent: certificateTableOffset > 0 && certificateTableSize > 0,
  };
}

export async function verifyPinnedWindowsProviderArchive(archivePath) {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) {
    throw new Error(`Pinned provider archive is not a file: ${archivePath}`);
  }
  if (archiveStat.size !== WINDOWS_CUA_DRIVER_RELEASE.assetBytes) {
    throw new Error(
      `Pinned provider archive size mismatch: expected ${WINDOWS_CUA_DRIVER_RELEASE.assetBytes}, found ${archiveStat.size}`,
    );
  }
  const sha256 = await sha256File(archivePath);
  if (sha256 !== WINDOWS_CUA_DRIVER_RELEASE.sha256) {
    throw new Error(
      `Pinned provider archive SHA-256 mismatch: expected ${WINDOWS_CUA_DRIVER_RELEASE.sha256}, found ${sha256}`,
    );
  }
  return {
    bytes: archiveStat.size,
    sha256,
  };
}

export async function verifyWindowsProviderBinary(binaryPath, label) {
  const bytes = await readFile(binaryPath);
  return {
    name: label,
    path: resolve(binaryPath),
    bytes: bytes.length,
    ...inspectWindowsX64Pe(bytes, label),
  };
}

export function isPathWithin(candidatePath, rootPath) {
  const normalizedCandidate = normalizeForComparison(resolve(candidatePath));
  const normalizedRoot = normalizeForComparison(resolve(rootPath));
  const pathFromRoot = relative(normalizedRoot, normalizedCandidate);
  return pathFromRoot.length > 0 && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export async function acquirePinnedWindowsProvider({
  outputDirectory,
  archivePath,
  keep = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const ownsTemporaryDirectory = !outputDirectory;
  const rootDirectory = outputDirectory
    ? await createExplicitTemporaryDirectory(outputDirectory)
    : await mkdtemp(join(tmpdir(), "ling-cua-driver-rs-v0.8.3-"));
  const retain = Boolean(outputDirectory || keep);

  try {
    const resolvedArchivePath = archivePath
      ? resolve(archivePath)
      : join(rootDirectory, WINDOWS_CUA_DRIVER_RELEASE.assetName);
    if (!archivePath) {
      await downloadPinnedArchive(resolvedArchivePath, fetchImpl);
    }

    const archive = await verifyPinnedWindowsProviderArchive(resolvedArchivePath);
    const extractionDirectory = join(rootDirectory, "provider");
    await mkdir(extractionDirectory);
    await extractZip(resolvedArchivePath, extractionDirectory);

    const providerDirectory = join(extractionDirectory, WINDOWS_CUA_DRIVER_RELEASE.assetRoot);
    const mainBinaryPath = join(providerDirectory, "cua-driver.exe");
    const uiaBinaryPath = join(providerDirectory, "cua-driver-uia.exe");
    const binaries = await Promise.all([
      verifyWindowsProviderBinary(mainBinaryPath, "cua-driver.exe"),
      verifyWindowsProviderBinary(uiaBinaryPath, "cua-driver-uia.exe"),
    ]);
    const versionProbe = await probePinnedProviderVersion(mainBinaryPath);
    const authenticode = await inspectAuthenticode([mainBinaryPath, uiaBinaryPath]);

    return {
      report: {
        schemaVersion: 1,
        mode: archivePath ? "local_pinned_archive" : "downloaded_pinned_release",
        release: WINDOWS_CUA_DRIVER_RELEASE,
        archive: {
          path: resolvedArchivePath,
          checksumVerified: true,
          ...archive,
        },
        binaries,
        versionProbe,
        authenticode,
        installation: {
          globalStateModified: false,
          upstreamInstallerExecuted: false,
          outputDirectory: rootDirectory,
          retained: retain,
        },
        signingClaim: authenticode.checked
          ? "Reported from Windows Get-AuthenticodeSignature; no signature status is assumed."
          : "Not checked on this host; archive checksum and PE architecture do not prove Authenticode trust.",
      },
      cleanup: retain ? async () => {} : async () => rm(rootDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyInstalledWindowsProvider(mainBinaryPath) {
  if (process.platform !== "win32") {
    throw new Error("--installed-binary is supported only on Windows because version and Authenticode checks must run there");
  }
  const resolvedMainBinaryPath = resolve(mainBinaryPath);
  const uiaBinaryPath = join(dirname(resolvedMainBinaryPath), "cua-driver-uia.exe");
  const binaries = await Promise.all([
    verifyWindowsProviderBinary(resolvedMainBinaryPath, "cua-driver.exe"),
    verifyWindowsProviderBinary(uiaBinaryPath, "cua-driver-uia.exe"),
  ]);
  const versionProbe = await probePinnedProviderVersion(resolvedMainBinaryPath);
  const authenticode = await inspectAuthenticode([resolvedMainBinaryPath, uiaBinaryPath]);
  return {
    schemaVersion: 1,
    mode: "installed_binary_read_only",
    expectedRelease: WINDOWS_CUA_DRIVER_RELEASE,
    archiveChecksumVerified: false,
    binaries,
    versionProbe,
    authenticode,
    installation: {
      globalStateModified: false,
      upstreamInstallerExecuted: false,
      outputDirectory: null,
      retained: true,
    },
    signingClaim: "Reported from Windows Get-AuthenticodeSignature; no signature status is assumed.",
  };
}

async function createExplicitTemporaryDirectory(outputDirectory) {
  const candidate = resolve(outputDirectory);
  const allowedRoots = [tmpdir(), process.env.RUNNER_TEMP]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolve(value));
  const resolvedRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return root;
      }
    }),
  );
  const parentDirectory = dirname(candidate);
  let resolvedParentDirectory;
  try {
    resolvedParentDirectory = await realpath(parentDirectory);
  } catch (error) {
    throw new Error(`--output-dir parent does not exist: ${parentDirectory} (${error?.message ?? error})`);
  }
  if (
    !resolvedRoots.some(
      (root) => samePath(resolvedParentDirectory, root) || isPathWithin(resolvedParentDirectory, root),
    )
  ) {
    throw new Error(
      `--output-dir must be a new child of the OS temp directory${process.env.RUNNER_TEMP ? " or RUNNER_TEMP" : ""}`,
    );
  }
  // Resolve the parent before creating the final component. This prevents a
  // symlink under /tmp from redirecting the verifier into a user directory.
  const safeCandidate = join(resolvedParentDirectory, candidate.slice(parentDirectory.length + 1));
  await access(resolvedParentDirectory);
  await mkdir(safeCandidate);
  return safeCandidate;
}

async function downloadPinnedArchive(destinationPath, fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required to download the pinned provider archive");
  }
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const partialPath = `${destinationPath}.partial`;
    try {
      await rm(partialPath, { force: true });
      const response = await fetchImpl(WINDOWS_CUA_DRIVER_RELEASE.url, {
        redirect: "follow",
        headers: {
          "User-Agent": "ling-stack-desktop-provider-verifier/1",
        },
      });
      if (!response.ok || !response.body) {
        throw new Error(`Provider download returned HTTP ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: "wx" }));
      await rename(partialPath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      await rm(partialPath, { force: true });
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await wait(attempt * 500);
      }
    }
  }
  throw new Error(`Unable to download the pinned Windows provider archive: ${lastError?.message ?? lastError}`);
}

async function extractZip(archivePath, destinationPath) {
  if (process.platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Expand-Archive -LiteralPath $env:LING_CUA_PROVIDER_ARCHIVE -DestinationPath $env:LING_CUA_PROVIDER_DESTINATION",
    ].join("; ");
    await runChild("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: {
        ...process.env,
        LING_CUA_PROVIDER_ARCHIVE: archivePath,
        LING_CUA_PROVIDER_DESTINATION: destinationPath,
      },
    });
    return;
  }
  await runChild("unzip", ["-q", archivePath, "-d", destinationPath]);
}

async function probePinnedProviderVersion(binaryPath) {
  if (process.platform !== "win32") {
    return {
      checked: false,
      expectedVersion: WINDOWS_CUA_DRIVER_RELEASE.version,
      reason: "Windows executable version probes are not run on a non-Windows host.",
    };
  }
  const result = await runChild(binaryPath, ["--version"], {
    cwd: dirname(binaryPath),
    timeoutMs: 10_000,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const expectedVersionPattern = new RegExp(
    `(^|[^0-9])${WINDOWS_CUA_DRIVER_RELEASE.version.replaceAll(".", "\\.")}([^0-9]|$)`,
  );
  if (!expectedVersionPattern.test(output)) {
    throw new Error(
      `Installed provider version output does not identify ${WINDOWS_CUA_DRIVER_RELEASE.version}: ${output || "<empty>"}`,
    );
  }
  return {
    checked: true,
    expectedVersion: WINDOWS_CUA_DRIVER_RELEASE.version,
    output,
  };
}

async function inspectAuthenticode(binaryPaths) {
  if (process.platform !== "win32") {
    return {
      checked: false,
      reason: "Authenticode trust is not evaluated on a non-Windows host.",
      files: binaryPaths.map((binaryPath) => ({ path: resolve(binaryPath), status: "not_checked" })),
    };
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = Get-AuthenticodeSignature -FilePath $env:LING_CUA_PROVIDER_BINARY",
    "[PSCustomObject]@{ Path = $env:LING_CUA_PROVIDER_BINARY; Status = [string]$signature.Status; StatusMessage = $signature.StatusMessage; SignerSubject = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress",
  ].join("; ");
  const items = await Promise.all(
    binaryPaths.map(async (binaryPath) => {
      const result = await runChild(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          env: {
            ...process.env,
            LING_CUA_PROVIDER_BINARY: binaryPath,
          },
        },
      );
      return JSON.parse(result.stdout.trim());
    }),
  );
  return {
    checked: true,
    trustRequired: false,
    files: items.map((item) => ({
      path: item.Path,
      status: item.Status,
      statusMessage: item.StatusMessage,
      signerSubject: item.SignerSubject || null,
    })),
  };
}

async function runChild(command, args, { cwd, env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectPromise(new Error(`${command} timed out after ${timeoutMs}ms`));
      } else if (exitCode !== 0) {
        rejectPromise(
          new Error(
            `${command} exited ${exitCode ?? signal ?? "unknown"}: ${`${stdout}\n${stderr}`.trim() || "<no output>"}`,
          ),
        );
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

function appendBounded(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= CHILD_OUTPUT_LIMIT ? next : next.slice(-CHILD_OUTPUT_LIMIT);
}

function normalizeForComparison(pathValue) {
  return process.platform === "win32" ? pathValue.toLowerCase() : pathValue;
}

function samePath(left, right) {
  return normalizeForComparison(resolve(left)) === normalizeForComparison(resolve(right));
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function printHelp() {
  process.stdout.write(`Usage:\n\n`);
  process.stdout.write(`  node apps/desktop/tests/verify-windows-cua-driver-provider.mjs [--output-dir <temp-path>] [--archive <zip>] [--keep]\n`);
  process.stdout.write(`  node apps/desktop/tests/verify-windows-cua-driver-provider.mjs --installed-binary <cua-driver.exe>\n\n`);
  process.stdout.write(`The acquisition path downloads only the pinned release asset, verifies its exact size and SHA-256, and extracts it under a test temp directory. It never runs the upstream installer or writes to an installation directory.\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "output-dir": { type: "string" },
      archive: { type: "string" },
      "installed-binary": { type: "string" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printHelp();
    return;
  }
  if (values["installed-binary"]) {
    if (values["output-dir"] || values.archive || values.keep) {
      throw new Error("--installed-binary cannot be combined with acquisition options");
    }
    const report = await verifyInstalledWindowsProvider(values["installed-binary"]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const acquired = await acquirePinnedWindowsProvider({
    outputDirectory: values["output-dir"],
    archivePath: values.archive,
    keep: values.keep,
  });
  try {
    process.stdout.write(`${JSON.stringify(acquired.report, null, 2)}\n`);
  } finally {
    await acquired.cleanup();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Windows Cua Driver provider verification failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
