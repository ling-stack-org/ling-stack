import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function supportsNativeHostBuild(platform, arch) {
  return (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64");
}

export async function runBrowserHostTests({
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
} = {}) {
  const isolatedRoot = await mkdtemp(join(tmpdir(), "ling-browser-host-tests-"));
  const isolatedHome = join(isolatedRoot, "home");
  const isolatedWorkspace = join(isolatedRoot, "workspace");
  await Promise.all([mkdir(isolatedHome), mkdir(isolatedWorkspace)]);
  const environment = {
    ...process.env,
    LING_STACK_HOME: isolatedHome,
    LING_STACK_DEFAULT_WORKSPACE_CWD: isolatedWorkspace,
  };

  try {
    if (supportsNativeHostBuild(platform, arch)) {
      run(process.execPath, ["scripts/build-native.mjs"], { env: environment });
    }

    const tests = (await readdir(resolve(packageRoot, "test")))
      .filter((file) => file.endsWith(".test.mjs"))
      .sort()
      .map((file) => `test/${file}`);
    run(process.execPath, ["--test", ...tests], { env: environment });
    run(process.env.CARGO ?? "cargo", ["test", "--manifest-path", "native/Cargo.toml"], { env: environment });
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

function runCommand(command, args, { env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBrowserHostTests();
}
