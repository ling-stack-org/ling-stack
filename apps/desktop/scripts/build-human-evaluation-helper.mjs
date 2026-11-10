import { spawnSync } from "node:child_process";
import { mkdirSync, chmodSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Fixed native input/output; no caller-supplied compiler, source or resource path.
export function buildHumanEvaluationHelper() {
if (process.platform !== "darwin"
  || !["arm64", "x64"].includes(process.arch)) throw new Error("human_helper_build_unsupported");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist/human-evaluation/ling-human-evaluation-helper");
mkdirSync(resolve(root, "dist/human-evaluation"), { recursive: true, mode: 0o700 });
const temporary = `${output}.${process.pid}.next`;
const build = spawnSync("/usr/bin/xcrun", ["swiftc", "-O", "-target",
  `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
  resolve(root, "scripts/native/human-evaluation-darwin.swift"), "-o", temporary],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (build.status !== 0) throw new Error(`human_helper_build_failed:${build.stderr}`);
chmodSync(temporary, 0o755);
const probe = spawnSync(temporary, [], { input: JSON.stringify({ command: "session", protocol: 1 }), encoding: "utf8" });
if (probe.status !== 0) throw new Error("human_helper_session_probe_failed");
const value = JSON.parse(probe.stdout);
if (!/^[a-f0-9]{64}$/.test(value.osSessionId) || !/^[a-f0-9]{64}$/.test(value.osUserId)
  || typeof value.active !== "boolean" || typeof value.locked !== "boolean") throw new Error("human_helper_session_probe_invalid");
renameSync(temporary, output);
return Object.freeze({ built: true, architecture: process.arch, sessionProbe: true, output });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("human_helper_build_arguments_invalid");
  process.stdout.write(`${JSON.stringify(buildHumanEvaluationHelper())}\n`);
}
