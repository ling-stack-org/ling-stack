import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeTarget } from "./build-native-runtime.mjs";
import { bundleFile } from "./executable-bundle.mjs";
import { requireResourceLease, resourceCheckpoint, within } from "./resource-workspace.mjs";
import { parserBuildEnvironment } from "./build-shell-parser.mjs";

/** Build the exact checked-in Go module; never download an unpinned parser executable. */
export async function buildShellParser({ outputPath, goCommand = "go" }) {
  const lease = await requireResourceLease();
  outputPath = resolve(outputPath);
  if (dirname(outputPath) !== join(lease.root, "artifacts/report") && !within(lease.scratchPath, outputPath)) throw new Error("gstack_shell_parser_output_outside_workspace");
  const scripts = dirname(fileURLToPath(import.meta.url)), source = join(scripts, "shell-ast");
  const inputs = await Promise.all(["main.go", "go.mod", "go.sum", "THIRD-PARTY-NOTICES"].map(path => bundleFile(source, path)));
  const work = await mkdtemp(join(lease.scratchPath, "tmp", "shell-parser-"));
  let completed = false;
  try {
    const code = join(work, "code");
    await mkdir(code);
    for (const input of inputs) {
      await copyFile(join(source, input.path), join(code, input.path));
      if (JSON.stringify(await bundleFile(code, input.path)) !== JSON.stringify(input)) throw new Error("gstack_shell_parser_build_copy_snapshot_changed");
    }
    // Both parser delivery formats share the E6 allowlisted compiler environment.
    // Compile a verified copy, not mutable repository paths.
    const env = { ...parserBuildEnvironment(lease), GOENV: "off", GOFLAGS: "",
      GOOS: process.platform === "win32" ? "windows" : "darwin", GOARCH: process.arch === "x64" ? "amd64" : "arm64" };
    const command = await realpath(isAbsolute(goCommand) ? goCommand : execFileSync(process.platform === "win32" ? "where.exe" : "which", [goCommand],
      { env, encoding: "utf8", timeout: 10000 }).trim().split(/\r?\n/)[0]);
    const version = execFileSync(command, ["version"], { env, encoding: "utf8", timeout: 10000 }).trim();
    const minimum = /\ngo (\d+\.\d+\.\d+)\n/.exec(await readFile(join(code, "go.mod"), "utf8"))?.[1];
    const actual = /\bgo(\d+\.\d+\.\d+)\b/.exec(version)?.[1];
    const numbers = value => value?.split(".").reduce((n, x) => n * 1000 + Number(x), 0);
    if (!actual || numbers(actual) < numbers(minimum)) throw new Error(`gstack_shell_parser_requires_go_${minimum}`);
    const outputs = [];
    for (const pass of ["first", "second"]) {
      const binary = join(work, `${pass}${process.platform === "win32" ? ".exe" : ""}`);
      execFileSync(command, ["build", "-trimpath", "-buildvcs=false", "-mod=readonly", "-ldflags=-buildid=", "-o", binary, "."],
        { cwd: code, env, timeout: 5 * 60_000, maxBuffer: 2 * 1024 ** 2 });
      assertNativeTarget(await readFile(binary), { platform: process.platform, arch: process.arch });
      outputs.push({ binary, ...(await bundleFile(work, `${pass}${process.platform === "win32" ? ".exe" : ""}`)) });
    }
    if (outputs[0].checksum !== outputs[1].checksum || outputs[0].sizeBytes !== outputs[1].sizeBytes) throw new Error("gstack_shell_parser_repeated_build_changed");
    for (const expected of inputs) if (JSON.stringify(await bundleFile(source, expected.path)) !== JSON.stringify(expected)
      || JSON.stringify(await bundleFile(code, expected.path)) !== JSON.stringify(expected)) throw new Error("gstack_shell_parser_source_changed");
    const producer = await bundleFile(resolve(scripts, "../.."), "scripts/gstack/build-shell-parser-binary.mjs");
    const report = { schemaVersion: 1, releaseEligible: false, target: { platform: process.platform, arch: process.arch },
      binding: "pinned-module-and-repeated-native-byte-identity", version, compiler: await bundleFile(dirname(command), command.slice(dirname(command).length + 1)),
      inputs, producer, artifact: { checksum: outputs[0].checksum, sizeBytes: outputs[0].sizeBytes } };
    await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(outputs[0].binary, outputPath, 1);
    await writeFile(`${outputPath}.provenance.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    await resourceCheckpoint(lease.root);
    completed = true;
    return report;
  } finally {
    // A failed compiler can have surviving children. Leave failure staging in
    // this lease for the outer supervisor's process-settlement cleanup.
    if (completed) await rm(work, { recursive: true, force: true });
  }
}
