import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";
import { matchesNativeDependency } from "./runtime-dependency-audit.mjs";

const source = fileURLToPath(new URL("./shell-ast/", import.meta.url));
const inputs = ["main.go", "go.mod", "go.sum", "THIRD-PARTY-NOTICES"];
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function parserBuildEnvironment(lease, inherited = process.env) {
  return { PATH: inherited.PATH, HOME: join(lease.scratchPath, "home"), TMPDIR: join(lease.scratchPath, "tmp"),
    GOCACHE: join(lease.root, "cache/go-build"), GOMODCACHE: join(lease.root, "cache/go-modules"),
    GOTOOLCHAIN: "local", GOPROXY: "https://proxy.golang.org", GOSUMDB: "sum.golang.org", CGO_ENABLED: "0" };
}

export async function buildShellParser({ outputPath, goCommand = "go" }) {
  const output = resolve(outputPath), lease = await managedResourceWrite(output, { kind: "source", additionalBytes: 512 * 1024 ** 2 });
  const work = await mkdtemp(join(lease.scratchPath, "shell-parser-")), candidate = join(work, "candidate"), code = join(work, "code");
  try {
    await mkdir(candidate); await mkdir(code);
    const records = [];
    for (const path of inputs) {
      records.push({ path, checksum: digest(await readFile(join(source, path))) });
      await copyFile(join(source, path), join(code, path));
      if (digest(await readFile(join(code, path))) !== records.at(-1).checksum) {
        throw new Error("gstack_shell_parser_build_copy_snapshot_changed");
      }
    }
    const env = parserBuildEnvironment(lease);
    const goVersion = execFileSync(goCommand, ["version"], { env, encoding: "utf8", timeout: 10000 }).trim();
    execFileSync(goCommand, ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-o", join(candidate, "shell-ast"), "."],
      { cwd: code, env, encoding: "utf8", timeout: 180000, maxBuffer: 1024 ** 2 });
    const target = { platform: process.platform, arch: process.arch };
    if (!await matchesNativeDependency(join(candidate, "shell-ast"), target)) throw new Error("gstack_shell_parser_build_target_mismatch");
    for (const record of records) if (digest(await readFile(join(source, record.path))) !== record.checksum
      || digest(await readFile(join(code, record.path))) !== record.checksum) {
      throw new Error("gstack_shell_parser_build_inputs_changed");
    }
    const receipt = { schemaVersion: 1, scope: "build-only-parse-helper-not-client-runtime", target, goVersion,
      inputs: records, parserChecksum: digest(await readFile(join(candidate, "shell-ast"))) };
    await writeFile(join(candidate, "parser-build.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await resourceCheckpoint(lease.root);
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output, { mode: 0o700 });
    try { await rename(candidate, output); }
    catch (error) { await rmdir(output).catch(() => {}); throw error; }
    return receipt;
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath, goCommand, ...extra] = process.argv.slice(2);
  if (!outputPath || extra.length) throw new Error("gstack_shell_parser_build_arguments_invalid");
  console.log(JSON.stringify(await buildShellParser({ outputPath, goCommand })));
}
