import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const [kind, compiler, records, ...args] = process.argv.slice(2);
const flags = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json"];
let name, actual;
if (kind === "bun") {
  if (JSON.stringify(args.slice(0, 7)) !== JSON.stringify(["build", "--compile", ...flags, "lib/cso/cli.ts"]) ||
    args.length !== 9 || args[7] !== "--outfile" || basename(args[8]) !== "gstack-cso-core") {
    throw new Error("gstack_cso_unreviewed_bun_recipe");
  }
  name = "core";
  actual = ["--no-env-file", "--no-install", ...args, `--metafile=${join(records, "core-metafile.json")}`];
} else if (kind === "cc") {
  const source = args.filter(arg => /^lib\/cso\/(?:watchdog|launcher|publish-lock)\.c$/.test(arg));
  if (source.length !== 1 || !args.includes("-o")) throw new Error("gstack_cso_unreviewed_c_recipe");
  name = basename(source[0], ".c");
  const common = ["-std=c11", "-D_POSIX_C_SOURCE=200809L", "-O2", "-Wall", "-Wextra"];
  const extra = name === "launcher" ? ["-Wl,-sectcreate,__RESTRICT,__restrict,/dev/null", args[6]] : [];
  if (name === "launcher" && !/^-DGSTACK_CSO_CORE_SHA256="[a-f0-9]{64}"$/.test(args[6] ?? "")) {
    throw new Error("gstack_cso_core_binding_invalid");
  }
  if (JSON.stringify(args) !== JSON.stringify([...common, ...extra, source[0], "-o", args.at(-1)])) {
    throw new Error("gstack_cso_unreviewed_c_recipe");
  }
  actual = [...args, "-MD", "-MF", join(records, `${name}.d`), "-MT", "ling"];
} else throw new Error("gstack_cso_compiler_kind_invalid");
execFileSync(compiler, actual, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 1024 ** 2 });
const output = args[args.indexOf(kind === "bun" ? "--outfile" : "-o") + 1];
if (resolve(output) === resolve(compiler)) throw new Error("gstack_cso_compiler_output_overlap");
const normalized = args.map(arg => arg.startsWith(process.cwd()) ? `<runtime>/${arg.slice(process.cwd().length + 1).replace(/\.gstack-cso-stage\.[^/]+\//, ".gstack-cso-stage/<stage>/")}` : arg);
const bytes = await readFile(output);
await writeFile(join(records, `${name}.json`), `${JSON.stringify({ kind, args: normalized,
  outputBytes: bytes.length, outputChecksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}` })}\n`, { flag: "wx" });
