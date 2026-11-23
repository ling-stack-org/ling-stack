import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = new URL("../dist/ling-server/", import.meta.url);
const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/ling-server-cli.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("ling-server.mjs", output)),
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  metafile: true,
  write: false,
});

if (Object.values(result.metafile.outputs).some(file => file.imports.some(item => !isBuiltin(item.path)))) {
  throw new Error("The Ling Server bundle must run with Node.js built-ins");
}
await mkdir(output, { recursive: true });
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("LICENSE", output));
await writeFile(new URL("ling-server.mjs", output), result.outputFiles[0].contents, { mode: 0o755 });
