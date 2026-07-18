import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.platform;

if (!new Set(["darwin", "win32"]).has(platform)) {
  process.stdout.write(
    `${JSON.stringify({ kind: "ling-cua-driver-electron-builder-fixture", platform, skipped: true })}\n`,
  );
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), `ling-cua-electron-builder-${platform}-`));
try {
  const providerRoot = join(root, "0.8.3-ling.1");
  const outputRoot = join(root, "builder-output");
  const providerPath =
    platform === "win32"
      ? join(providerRoot, "win32-x64", "payload", "cua-driver.exe")
      : join(providerRoot, "darwin", "cua-driver");
  await mkdir(dirname(providerPath), { recursive: true });
  await writeFile(join(providerRoot, "provider-lock.json"), `${platform}-builder-fixture-lock\n`);
  await writeFile(providerPath, Buffer.from(`electron-builder-provider-fixture:${platform}`));

  const executable = join(desktopRoot, "node_modules", ".bin", "electron-builder");
  const args = [
    "--dir",
    "--config",
    "./scripts/cua-driver-signing/electron-builder.signing-feasibility.config.mjs",
    platform === "darwin" ? "--mac" : "--win",
    process.arch === "arm64" && platform === "darwin" ? "--arm64" : "--x64",
  ];
  await run(executable, args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      LING_CUA_SIGNING_FIXTURE: "1",
      LING_CUA_SIGNING_TIER: "test_signed_internal",
      LING_CUA_DISTRIBUTION_CHANNEL: "internal",
      LING_CUA_TEST_AUTHORITY_KIND: "ephemeral-ci",
      LING_CUA_FIXTURE_PROVIDER_ROOT: providerRoot,
      LING_CUA_FIXTURE_OUTPUT: outputRoot,
    },
  });

  const traces = await findNamedFiles(outputRoot, "provider-signing-trace.json");
  if (traces.length !== 1) {
    throw new Error(`electron_builder_fixture_trace_count_invalid:${traces.length}`);
  }
  const trace = JSON.parse(await readFile(traces[0], "utf8"));
  const eventNames = trace.events.map((event) => `${event.hook}:${event.event}`);
  for (const required of [
    "afterPack:started",
    "afterPack:provider-pre-sign-digest",
    "afterPack:provider-signed",
    "afterPack:provider-sealed",
    "platformSign:outer-path-signed",
    "afterSign:started",
    "afterSign:verified",
  ]) {
    if (!eventNames.includes(required)) {
      throw new Error(`electron_builder_fixture_hook_missing:${required}`);
    }
  }
  const sealEvent = trace.events.find(
    (event) => event.hook === "afterPack" && event.event === "provider-sealed",
  );
  const afterSign = trace.events.find(
    (event) => event.hook === "afterSign" && event.event === "verified",
  );
  if (!sealEvent || !afterSign || sealEvent.providerSha256 !== afterSign.providerSha256) {
    throw new Error("electron_builder_fixture_provider_digest_changed_after_seal");
  }

  const retainedDirectory = join(desktopRoot, "test-results", "cua-driver-signing-feasibility");
  await mkdir(retainedDirectory, { recursive: true });
  const retainedTrace = join(retainedDirectory, `electron-builder-${platform}-trace.json`);
  await writeFile(retainedTrace, `${JSON.stringify(trace, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      kind: "ling-cua-driver-electron-builder-fixture",
      electronBuilderVersion: trace.electronBuilderVersion,
      platform,
      skipped: false,
      providerSha256: sealEvent.providerSha256,
      retainedTrace,
      hooks: eventNames,
    })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function run(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `electron_builder_fixture_failed:code=${String(code)}:signal=${String(signal)}`,
          ),
        );
      }
    });
  });
}

async function findNamedFiles(root, name) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name === name) {
        result.push(path);
      }
    }
  }
  await walk(root);
  return result.sort();
}
