import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

class CandidateError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function configuration(value) {
  const keys = ["executablePath", "model", "provider", "providerConfiguration", "credentialEnvironment"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !keys.includes(key))) throw new CandidateError("candidate_config_invalid");
  const provider = value.providerConfiguration;
  if (typeof value.executablePath !== "string" || !isAbsolute(value.executablePath)
    || value.executablePath.length > 4096 || /[\x00-\x1f\x7f]/.test(value.executablePath)
    || typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value.model)
    || typeof value.provider !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.provider)
    || typeof value.credentialEnvironment !== "string" || !/^LING_NATIVE_CANDIDATE_[A-Z0-9_]+$/.test(value.credentialEnvironment)
    || !provider || typeof provider !== "object" || Array.isArray(provider)
    || Object.keys(provider).sort().join(",") !== "base_url,name,wire_api"
    || typeof provider.name !== "string" || provider.name.length < 1 || provider.name.length > 128 || /[\x00-\x1f]/.test(provider.name)
    || provider.wire_api !== "responses" || typeof provider.base_url !== "string") throw new CandidateError("candidate_config_invalid");
  let url;
  try { url = new URL(provider.base_url); } catch { throw new CandidateError("candidate_config_invalid"); }
  if (url.username || url.password || url.search || url.hash || provider.base_url.length > 2048
    || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new CandidateError("candidate_config_invalid");
  }
  return value;
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--output") throw new CandidateError("candidate_arguments_invalid");
  let parsed;
  let configurationBytes;
  try {
    const descriptor = await open(resolve(args[1]), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await descriptor.stat();
      if (!info.isFile() || info.size > 16 * 1024) throw new Error();
      const buffer = Buffer.alloc(16 * 1024 + 1);
      const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
      const after = await descriptor.stat();
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error();
      configurationBytes = buffer.subarray(0, bytesRead);
      parsed = JSON.parse(configurationBytes.toString("utf8"));
    } finally { await descriptor.close(); }
  } catch { throw new CandidateError("candidate_config_invalid"); }
  const input = configuration(parsed);
  const credential = process.env[input.credentialEnvironment];
  if (!credential || credential.length > 16 * 1024 || credential.trim() !== credential || /[\x00-\x1f\x7f]/.test(credential)) throw new CandidateError("candidate_credential_missing");
  const { runCandidate } = await import("./candidate-runner.mjs");
  const result = await runCandidate({ input, credential, output: resolve(args[3]), configurationPath: resolve(args[1]), configurationBytes });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "failed" ? 1 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const code = error instanceof CandidateError || ["candidate_output_exists", "candidate_output_invalid"].includes(error.code)
      ? error.code : "candidate_preflight_failed";
    process.stdout.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
}
