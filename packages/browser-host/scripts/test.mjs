import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  if (supportsNativeHostBuild(platform, arch)) {
    run(process.execPath, ["scripts/build-native.mjs"]);
  }

  const tests = (await readdir(resolve(packageRoot, "test")))
    .filter((file) => file.endsWith(".test.mjs"))
    .sort()
    .map((file) => `test/${file}`);
  run(process.execPath, ["--test", ...tests]);
  run(process.env.CARGO ?? "cargo", ["test", "--manifest-path", "native/Cargo.toml"]);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBrowserHostTests();
}
