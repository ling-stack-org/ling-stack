import electronPath from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const suppliedUserDataDirectory = process.env.LING_DESKTOP_SMOKE_USER_DATA_DIR?.trim();
const ownsUserDataDirectory = !suppliedUserDataDirectory;
const userDataDirectory = suppliedUserDataDirectory ||
  await mkdtemp(join(tmpdir(), "ling-desktop-computer-use-smoke-"));
const suppliedWorkspaceDirectory = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD?.trim();
const ownsWorkspaceDirectory = !suppliedWorkspaceDirectory;
const workspaceDirectory = suppliedWorkspaceDirectory
  ? resolve(suppliedWorkspaceDirectory)
  : await mkdtemp(join(tmpdir(), "ling-desktop-computer-use-workspace-"));
const suppliedLingStackHome = process.env.LING_STACK_HOME?.trim();
const lingStackHome = suppliedLingStackHome || join(userDataDirectory, "ling-stack-home");
const suppliedDaemonUrl = process.env.LING_STACK_DAEMON_URL?.trim();
const daemonUrl = suppliedDaemonUrl || `http://127.0.0.1:${await availablePort()}`;
const mobileGatewayPort = await availablePort();
const packagedExecutableValue = process.env.LING_DESKTOP_SMOKE_EXECUTABLE?.trim();
const packagedExecutable = packagedExecutableValue ? resolve(packagedExecutableValue) : undefined;
const smokeTimeoutMs = positiveInteger(process.env.LING_DESKTOP_SMOKE_TIMEOUT_MS, 20_000);
const realCapture = process.env.LING_DESKTOP_REAL_CAPTURE_SMOKE === "1" || process.argv.includes("--real");
const realDisplayCapture = process.argv.includes("--display");

try {
  const result = await runElectron({
    executable: packagedExecutable || electronPath,
    args: [
      ...(packagedExecutable ? [] : [desktopRoot]),
      "--ling-desktop-smoke-headless",
      realDisplayCapture
        ? "--ling-desktop-real-display-capture-smoke"
        : realCapture
          ? "--ling-desktop-real-capture-smoke"
          : "--ling-desktop-fake-computer-use",
      `--user-data-dir=${userDataDirectory}`,
    ],
    env: {
      ...process.env,
      ...(realCapture || realDisplayCapture ? {} : { LING_DESKTOP_FAKE_COMPUTER_USE: "1" }),
      LING_STACK_HOME: lingStackHome,
      LING_STACK_DAEMON_URL: daemonUrl,
      LING_MOBILE_GATEWAY_PORT: String(mobileGatewayPort),
      LING_STACK_DEFAULT_WORKSPACE_CWD: workspaceDirectory,
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) {
    throw new Error(`Desktop fake Computer Use smoke timed out after ${smokeTimeoutMs}ms:\n${output}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Desktop fake Computer Use smoke exited ${result.exitCode ?? result.signal ?? "unknown"}:\n${output}`);
  }
  const expectedMarker = realCapture || realDisplayCapture
    ? "Ling Stack Desktop direct Electron Computer Use capture lifecycle passed"
    : "Ling Stack Desktop fake Computer Use lifecycle passed";
  if (!output.includes(expectedMarker)) {
    throw new Error(`Desktop fake Computer Use smoke did not complete the lifecycle:\n${output}`);
  }
  for (const line of output.split(/\r?\n/u)) {
    if (
      line.startsWith("LING_DESKTOP_PROJECTION_ID=") ||
      line.includes("Ling Stack Desktop daemon projection persistence checkpoint passed")
    ) {
      process.stdout.write(`${line}\n`);
    }
  }
  process.stdout.write(
    realCapture || realDisplayCapture
      ? "Desktop direct Electron Computer Use capture first-frame/hide/show/stop smoke passed\n"
      : "Desktop fake Computer Use first-frame/hide/show/stop smoke passed\n",
  );
} finally {
  if (ownsUserDataDirectory) {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
  if (ownsWorkspaceDirectory) {
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
}

async function runElectron({ executable, args, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: desktopRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, smokeTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (!port) {
          reject(new Error("Unable to allocate Desktop smoke port"));
        } else {
          resolve(port);
        }
      });
    });
  });
}

function boundedAppend(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= 100_000 ? next : next.slice(-100_000);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
