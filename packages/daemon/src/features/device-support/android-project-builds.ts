import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync, statSync } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isAndroidApkFileName, isRemoteDeviceArtifactName, type DeviceDeveloperArtifactV1 } from "@ling-stack/contracts";
import { DeviceBrokerError, type SqliteDeviceDeveloperStore } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import type { AndroidApkLibrary, VerifiedAndroidApk } from "./android-apks.js";

const runFile = promisify(execFile);
const identifier = /^[a-z0-9_-]{1,128}$/iu;
const environmentKey = /^[a-z_][a-z0-9_]{0,127}$/iu;
const logBudget = 128 * 1024;
const systemBuildEnvironment = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME",
  "TMP", "TEMP", "TMPDIR", "LANG", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GRADLE_USER_HOME",
];

interface AndroidProjectBuild {
  readonly buildId: string;
  readonly directory: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly apkPath: string;
  readonly variant: string;
  readonly toolchain: string;
  readonly passEnvironment: readonly string[];
}

export function readAndroidProjectBuilds(path: string | undefined): readonly AndroidProjectBuild[] {
  if (!path) return [];
  if (!isAbsolute(path)) throw new Error("Invalid Android project build configuration path");
  const file = statSync(path);
  if (!file.isFile() || file.size > 64 * 1024) throw new Error("Invalid Android project build configuration file");
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(config) || config.version !== 1 || !Array.isArray(config.builds) || Object.keys(config).length !== 2) {
    throw new Error("Invalid Android project build configuration");
  }
  const builds: AndroidProjectBuild[] = config.builds.map((value: unknown) => {
    if (!isRecord(value) || Object.keys(value).some(key =>
      !["buildId", "directory", "executable", "args", "apkPath", "variant", "toolchain", "passEnvironment"].includes(key))) {
      throw new Error("Invalid Android project build");
    }
    const { buildId, directory, executable, args, apkPath, variant, toolchain, passEnvironment = [] } = value;
    if (typeof buildId !== "string" || !identifier.test(buildId)
      || !relativePath(directory) || !relativePath(apkPath) || !isRemoteDeviceArtifactName(basename(apkPath)) || !isAndroidApkFileName(apkPath)
      || typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0")
      || !Array.isArray(args) || args.length > 128 || !args.every(arg => typeof arg === "string" && arg.length <= 8192 && !arg.includes("\0"))
      || !Array.isArray(passEnvironment) || passEnvironment.length > 64
      || !passEnvironment.every(key => typeof key === "string" && environmentKey.test(key))
      || !label(variant) || !label(toolchain)) throw new Error("Invalid Android project build");
    return { buildId, directory, executable, args, apkPath, variant, toolchain, passEnvironment };
  });
  if (new Set(builds.map(build => build.buildId)).size !== builds.length) throw new Error("Duplicate Android project build ID");
  return builds;
}

type BuildArtifact = VerifiedAndroidApk & { readonly build: NonNullable<DeviceDeveloperArtifactV1["build"]> };

export function readProjectBuildArtifact(store: SqliteDeviceDeveloperStore, workspaceId: string, jobId: string) {
  const job = store.getJob(jobId);
  if (job?.kind !== "build" || job.status !== "completed" || !job.outputRef || !job.buildId) return undefined;
  const session = store.getSession(job.sessionId);
  if (session?.ownerKind !== "daemon" || session.workspaceId !== workspaceId || session.ownerId !== workspaceId
    || session.targetDeviceId !== job.targetDeviceId) return undefined;
  const artifact = store.getArtifact(job.outputRef);
  if (artifact?.build?.jobId !== jobId || artifact.build.buildId !== job.buildId || artifact.workspaceId !== workspaceId
    || artifact.targetDeviceId !== job.targetDeviceId || artifact.digest !== "sha256:" + job.outputDigest
    || !artifact.packageId || !artifact.androidApk) return undefined;
  return { artifact, build: artifact.build, packageId: artifact.packageId, versionCode: artifact.androidApk.versionCode };
}

export class AndroidProjectBuilds {
  private readonly active = new Set<string>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly logsDirectory: string,
    private readonly builds: readonly AndroidProjectBuild[],
    private readonly apks?: AndroidApkLibrary,
  ) {}

  list() {
    return this.apks ? this.builds.map(({ buildId, directory, variant, toolchain }) => ({ buildId, directory, variant, toolchain })) : [];
  }

  get(buildId: string) {
    return this.apks ? this.builds.find(build => build.buildId === buildId) : undefined;
  }

  async run(
    build: AndroidProjectBuild, jobId: string, signal: AbortSignal, authorize: () => void,
  ): Promise<BuildArtifact | undefined> {
    const apks = this.apks;
    if (!apks) throw new DeviceBrokerError("unsupported_capability", "Android APK tools are unavailable");
    const workspace = await realpath(this.workspaceRoot);
    const cwd = await ownedPath(workspace, build.directory);
    if (this.active.has(cwd)) throw new DeviceBrokerError("service_unavailable", "An Android build is already running in this project");
    this.active.add(cwd);
    try {
      const source = await gitSource(cwd, signal);
      signal.throwIfAborted();
      authorize();
      const log = await runBuild(build, cwd, signal);
      await this.writeLog(jobId, log);
      signal.throwIfAborted();
      if (log.exitCode !== 0) return undefined;
      const finishedSource = await gitSource(cwd, signal);
      if (source?.sourceRevision !== finishedSource?.sourceRevision) {
        throw new DeviceBrokerError("target_changed", "Project source revision changed while building");
      }
      const output = await ownedPath(cwd, build.apkPath);
      const file = await open(output, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new DeviceBrokerError("invalid_request", "Project build did not produce an APK file");
        const configurationDigest = "sha256:" + createHash("sha256").update(JSON.stringify(build)).digest("hex");
        const sourceModified = source?.sourceModified === true || finishedSource?.sourceModified === true
          ? true : source?.sourceModified === false && finishedSource?.sourceModified === false ? false : undefined;
        const bytes = file.createReadStream({ autoClose: false, signal });
        try {
          return await apks.importApk(bytes, stat.size, authorize, apk => ({
            ...apk, build: {
              jobId, buildId: build.buildId, fileName: basename(build.apkPath), configurationDigest,
              toolchain: build.toolchain, variant: build.variant, ...(source ? { sourceRevision: source.sourceRevision } : {}),
              ...(sourceModified === undefined ? {} : { sourceModified }),
            },
          }));
        } finally {
          bytes.destroy();
        }
      } finally {
        await file.close();
      }
    } finally {
      this.active.delete(cwd);
    }
  }

  async readLog(jobId: string): Promise<ProjectBuildLog | undefined> {
    try {
      return JSON.parse(await readFile(this.logPath(jobId), "utf8")) as ProjectBuildLog;
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    }
  }

  private async writeLog(jobId: string, log: ProjectBuildLog): Promise<void> {
    await mkdir(this.logsDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(this.logsDirectory, "." + randomUUID());
    try {
      await writeFile(temporary, JSON.stringify(log), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.logPath(jobId));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private logPath(jobId: string): string {
    if (!identifier.test(jobId)) throw new DeviceBrokerError("invalid_request", "Invalid project build job ID");
    return join(this.logsDirectory, jobId + ".json");
  }
}

type ProjectBuildLog = { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly truncated: boolean };

function runBuild(build: AndroidProjectBuild, cwd: string, signal: AbortSignal): Promise<ProjectBuildLog> {
  return new Promise((resolve, reject) => {
    const child = spawn(build.executable, build.args, {
      cwd, signal, env: processEnvironment(build.passEnvironment), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    function append(previous: Buffer, chunk: Buffer) {
      truncated ||= previous.length + chunk.length > logBudget;
      return Buffer.concat([previous, chunk]).subarray(-logBudget);
    }
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    let exitError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    child.once("error", error => {
      if (signal.aborted) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        killTimer.unref();
      } else exitError = error;
    });
    child.once("close", exitCode => {
      clearTimeout(killTimer);
      if (exitError) reject(exitError);
      else resolve({ exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated });
    });
  });
}

async function gitSource(cwd: string, signal: AbortSignal) {
  const options = { cwd, signal, env: processEnvironment([]), maxBuffer: 256 * 1024, windowsHide: true };
  const head = await runFile("git", ["rev-parse", "HEAD"], options).catch(() => undefined);
  signal.throwIfAborted();
  const sourceRevision = head?.stdout.trim();
  if (!sourceRevision || !/^[a-f0-9]{40,64}$/u.test(sourceRevision)) return undefined;
  const status = await runFile("git", ["status", "--porcelain=v1"], options).catch(() => undefined);
  signal.throwIfAborted();
  return { sourceRevision, ...(status ? { sourceModified: status.stdout.length > 0 } : {}) };
}

function processEnvironment(additional: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries([...systemBuildEnvironment, ...additional].map(name => [name, process.env[name]]));
}

async function ownedPath(root: string, path: string): Promise<string> {
  const candidate = await realpath(resolve(root, path));
  const subpath = relative(root, candidate);
  if (subpath === ".." || subpath.startsWith(".." + sep) || isAbsolute(subpath)) {
    throw new DeviceBrokerError("permission_denied", "Project build path is outside its workspace");
  }
  return candidate;
}

function relativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !isAbsolute(value) && !value.includes("\0");
}

function label(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
