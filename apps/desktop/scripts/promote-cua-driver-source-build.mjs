#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_RESOURCE_ROOT } from "./cua-driver-source-build-lib.mjs";
import { promoteCuaDriverSourceBuild } from "./cua-driver-source-build-promotion-lib.mjs";

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parsePromotionArgs(process.argv.slice(2));
    const result = await promoteCuaDriverSourceBuild({
      platform: args.platform,
      candidateA: args["candidate-a"],
      candidateB: args["candidate-b"],
      outputDir: args["output-dir"],
      resourceRoot: args["resource-root"] ?? PROVIDER_RESOURCE_ROOT,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === "promotion_usage_invalid" ? 2 : 1;
  }
}

export function parsePromotionArgs(values) {
  const allowed = new Set([
    "platform",
    "candidate-a",
    "candidate-b",
    "output-dir",
    "resource-root",
  ]);
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) usage(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) usage(`unknown option: --${key}`);
    if (result[key] !== undefined) usage(`duplicate option: --${key}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) usage(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  for (const key of ["platform", "candidate-a", "candidate-b", "output-dir"]) {
    if (result[key] === undefined) usage(`--${key} is required`);
  }
  if (result.platform !== "darwin" && result.platform !== "win32-x64") {
    usage("--platform must be darwin or win32-x64");
  }
  return Object.freeze(result);
}

function usage(message) {
  const error = new Error(
    `${message}; usage: promote-cua-driver-source-build.mjs --platform <darwin|win32-x64> --candidate-a <dir> --candidate-b <dir> --output-dir <dir> [--resource-root <dir>]`,
  );
  error.code = "promotion_usage_invalid";
  throw error;
}
