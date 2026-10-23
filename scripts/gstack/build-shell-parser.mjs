import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeTarget } from "./build-native-runtime.mjs";
import { bundleFile } from "./executable-bundle.mjs";
import { requireResourceLease, resourceCheckpoint, within } from "./resource-workspace.mjs";

/** Build the exact checked-in Go module; never download an unpinned parser executable. */
export async function buildShellParser({ outputPath, goCommand = "go" }) {
  const lease = await requireResourceLease();
  outputPath = resolve(outputPath);
  if (dirname(outputPath) !== join(lease.root, "artifacts/report") && !within(lease.scratchPath, outputPath)) throw new Error("gstack_shell_parser_output_outside_workspace");
  const scripts = dirname(fileURLToPath(import.meta.url)), source = join(scripts, "shell-ast");
  const command = await realpath(isAbsolute(goCommand) ? goCommand : execFileSync(process.platform === "win32" ? "where.exe" : "which", [goCommand],
    { encoding: "utf8" }).trim().split(/\r?\n/)[0]);
  const env = { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local", GOENV: "off", GOFLAGS: "", GOOS: process.platform === "win32" ? "windows" : "darwin", GOARCH: process.arch === "x64" ? "amd64" : "arm64" };
  const version = execFileSync(command, ["version"], { env, encoding: "utf8" }).trim();
  const minimum = /\ngo (\d+\.\d+\.\d+)\n/.exec(await readFile(join(source, "go.mod"), "utf8"))?.[1];
  const actual = /\bgo(\d+\.\d+\.\d+)\b/.exec(version)?.[1];
  const numbers = value => value?.split(".").reduce((n, x) => n * 1000 + Number(x), 0);
  if (!actual || numbers(actual) < numbers(minimum)) throw new Error(`gstack_shell_parser_requires_go_${minimum}`);
  const inputs = await Promise.all(["main.go", "go.mod", "go.sum", "THIRD-PARTY-NOTICES"].map(path => bundleFile(source, path)));
  const work = await mkdtemp(join(lease.scratchPath, "tmp", "shell-parser-"));
  try {
    const outputs = [];
    for (const pass of ["first", "second"]) {
      const binary = join(work, `${pass}${process.platform === "win32" ? ".exe" : ""}`);
      execFileSync(command, ["build", "-trimpath", "-buildvcs=false", "-mod=readonly", "-ldflags=-buildid=", "-o", binary, "."],
        { cwd: source, env, timeout: 5 * 60_000, maxBuffer: 2 * 1024 ** 2 });
      assertNativeTarget(await readFile(binary), { platform: process.platform, arch: process.arch });
      outputs.push({ binary, ...(await bundleFile(work, `${pass}${process.platform === "win32" ? ".exe" : ""}`)) });
    }
    if (outputs[0].checksum !== outputs[1].checksum || outputs[0].sizeBytes !== outputs[1].sizeBytes) throw new Error("gstack_shell_parser_repeated_build_changed");
    for (const expected of inputs) if (JSON.stringify(await bundleFile(source, expected.path)) !== JSON.stringify(expected)) throw new Error("gstack_shell_parser_source_changed");
    const producer = await bundleFile(resolve(scripts, "../.."), "scripts/gstack/build-shell-parser.mjs");
    const report = { schemaVersion: 1, releaseEligible: false, target: { platform: process.platform, arch: process.arch },
      binding: "pinned-module-and-repeated-native-byte-identity", version, compiler: await bundleFile(dirname(command), command.slice(dirname(command).length + 1)),
      inputs, producer, artifact: { checksum: outputs[0].checksum, sizeBytes: outputs[0].sizeBytes } };
    await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(outputs[0].binary, outputPath, 1);
    await writeFile(`${outputPath}.provenance.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    await resourceCheckpoint(lease.root);
    return report;
  } finally { await rm(work, { recursive: true, force: true }); }
}
