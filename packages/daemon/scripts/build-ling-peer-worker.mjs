import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../native/ling-peer-worker/", import.meta.url));
const output = fileURLToPath(new URL("../dist/native/ling-peer-worker/", import.meta.url));
const executable = process.platform === "win32" ? "ling-peer-worker.exe" : "ling-peer-worker";
const goArch = { arm64: "arm64", x64: "amd64" }[process.arch];
const goOs = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
if (!goOs || !goArch) throw new Error("ling_peer_worker_build_target_unsupported");
const env = { ...process.env, CGO_ENABLED: "0", GOARCH: goArch, GOOS: goOs, GOTOOLCHAIN: "local", GOWORK: "off" };

function go(args) {
  const result = spawnSync("go", args, { cwd: source, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error || result.status !== 0) throw new Error("ling_peer_worker_go_failed", { cause: result.error });
  return result.stdout.trim();
}

await mkdir(output, { recursive: true });
const candidate = join(output, "." + executable + "." + randomUUID());
try {
  go(["build", "-buildvcs=false", "-trimpath", "-mod=readonly", "-ldflags=-s -w", "-o", candidate, "."]);
  const modules = go(["list", "-mod=readonly", "-deps", "-f",
    '{{with .Module}}{{if not .Main}}{{.Path}}{{"\\t"}}{{.Version}}{{"\\t"}}{{.Dir}}{{end}}{{end}}', "."]);
  const dependencies = [...new Set(modules.split(/\r?\n/u).filter(Boolean))].sort();
  const licenses = [];
  for (const dependency of dependencies) {
    const [name, version, root] = dependency.split("\t");
    licenses.push(await readLicenseFiles(name + " " + version, root));
  }
  const goRoot = go(["env", "GOROOT"]);
  const goVersion = go(["env", "GOVERSION"]);
  licenses.push(await readLicenseFiles(goVersion, goRoot, basename(goRoot) === "libexec" ? dirname(goRoot) : undefined));
  const notices = licenses.join("\n\n") + "\n";
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const metadata = {
    schema: "ling.peer-worker.build.v1", platform: [process.platform, process.arch].join("-"),
    executable, sha256: digest(await readFile(candidate)), noticesSha256: digest(notices), goVersion,
    dependencies: dependencies.map(line => line.split("\t").slice(0, 2).join("@")),
  };
  await rename(candidate, join(output, executable));
  await writeFile(join(output, "THIRD_PARTY_LICENSES.txt"), notices);
  await writeFile(join(output, "build-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  process.stdout.write(JSON.stringify(metadata) + "\n");
} finally {
  await rm(candidate, { force: true });
}

async function readLicenseFiles(label, root, licenseRoot) {
  const locations = new Map();
  for (const directory of [licenseRoot, root].filter(Boolean)) {
    for (const name of await readdir(directory)) {
      if (/^(LICENSE|COPYING|NOTICE|PATENTS)(\.|$)/iu.test(name)) locations.set(name, join(directory, name));
    }
  }
  if (![...locations.keys()].some(name => /^(LICENSE|COPYING)(\.|$)/iu.test(name))) {
    throw new Error("ling_peer_worker_license_missing:" + label);
  }
  const sections = [label];
  for (const [name, source] of [...locations.entries()].sort()) sections.push(name + "\n" + (await readFile(source, "utf8")).trim());
  return sections.join("\n\n");
}
