import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pin from "./testsavant-model-pin.json" with { type: "json" };

export const testsavantPolicy = Object.freeze({ maxBytes: 65536, maxCharacters: 32768,
  maxTokens: 4096, windowTokens: 512, overlapTokens: 64 });
const fail = code => { throw new Error(`testsavant_${code}`); };

export async function verifyTestsavantRuntimeFiles(modelRoot) {
  if (resolve(modelRoot) !== modelRoot || await realpath(modelRoot) !== modelRoot ||
    !(await lstat(modelRoot)).isDirectory()) fail("model_root_invalid");
  for (const file of pin.files) {
    const path = join(modelRoot, file.path), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path || info.size !== file.sizeBytes) fail("model_file_invalid");
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(path)) digest.update(bytes);
    if (`sha256:${digest.digest("hex")}` !== file.checksum) fail("model_content_mismatch");
  }
}

// Matches the frozen upstream preprocessing while decoding each entity once.
export function testsavantPlainText(input) {
  if (!input.includes("<")) return input;
  return input.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot);/g, entity => ({
      "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    })[entity] ?? entity)
    .replace(/\s+/g, " ").trim();
}

export function planTestsavantWindows(ids) {
  if (!Array.isArray(ids) || !ids.length ||
    !ids.every(id => Number.isInteger(id) && id >= 0 && id < 30522)) fail("tokens_invalid");
  if (ids.length > testsavantPolicy.maxTokens) fail("token_budget_exceeded");
  const capacity = testsavantPolicy.windowTokens - 2, windows = [];
  for (let start = 0; start < ids.length; start += capacity - testsavantPolicy.overlapTokens) {
    const end = Math.min(start + capacity, ids.length);
    windows.push({ start, end, ids: [101, ...ids.slice(start, end), 102] });
    if (end === ids.length) break;
  }
  return windows;
}

export function testsavantScores(output) {
  if (output?.type !== "float32" || JSON.stringify(output.dims) !== "[1,2]" || output.data?.length !== 2 ||
    !Array.from(output.data).every(Number.isFinite)) fail("output_invalid");
  const injectionScore = 1 / (1 + Math.exp(output.data[0] - output.data[1]));
  return { label: injectionScore > 0.5 ? "INJECTION" : "SAFE",
    score: injectionScore > 0.5 ? injectionScore : 1 - injectionScore, injectionScore };
}

export function testsavantSignal(result) {
  return { layer: "testsavant_content", confidence: result.label === "INJECTION" ? result.score : 0,
    meta: { label: result.label, ...(result.label === "SAFE" ? { safeScore: result.score } : {}),
      coverage: "complete", tokens: result.tokens, windows: result.windows.length, aggregation: "maximum-window-score" } };
}

export async function createTestsavantClassifier({ runtimeRoot, modelRoot }) {
  await verifyTestsavantRuntimeFiles(modelRoot);
  const config = JSON.parse(await readFile(join(modelRoot, "config.json")));
  if (config.model_type !== "bert" || config.id2label?.[0] !== "SAFE" || config.id2label?.[1] !== "INJECTION" ||
    config.max_position_embeddings !== 512 || config.vocab_size !== 30522) fail("config_invalid");
  const entry = join(runtimeRoot, "node_modules/@huggingface/transformers/dist/transformers.node.mjs");
  const { AutoTokenizer, env } = await import(pathToFileURL(entry));
  env.allowRemoteModels = false; env.allowLocalModels = true;
  env.localModelPath = `${dirname(modelRoot)}/`; env.useFSCache = false; env.useBrowserCache = false;
  const tokenizer = await AutoTokenizer.from_pretrained(basename(modelRoot), { local_files_only: true });
  tokenizer._tokenizerConfig.model_max_length = 512;
  const ort = createRequire(entry)("onnxruntime-node");
  const session = await ort.InferenceSession.create(join(modelRoot, "onnx/model.onnx"), {
    executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1,
  });
  try {
    if (JSON.stringify(session.inputNames.slice().sort()) !== '["attention_mask","input_ids","token_type_ids"]' ||
      session.outputNames.length !== 1) fail("signature_invalid");
  } catch (error) { await session.release(); throw error; }
  let closed = false;
  async function score(ids) {
    if (closed) fail("closed");
    const dims = [1, ids.length];
    const output = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), dims),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), dims),
      token_type_ids: new ort.Tensor("int64", new BigInt64Array(ids.length), dims),
    });
    return testsavantScores(output[session.outputNames[0]]);
  }
  function validateText(text) {
    if (typeof text !== "string" || !text.trim() || text.length > testsavantPolicy.maxCharacters ||
      Buffer.byteLength(text) > testsavantPolicy.maxBytes) fail("text_invalid");
    const plain = testsavantPlainText(text);
    if (!plain.trim()) fail("empty_content");
    return plain;
  }
  return {
    // Comparison only. The actual gs entry below always uses complete windows.
    async scanLegacy(text) {
      const plain = validateText(text);
      const encoded = tokenizer(plain.slice(0, 4000), { truncation: true, max_length: 512, padding: false });
      const ids = Array.from(encoded.input_ids.data, Number);
      return { ...await score(ids), tokens: ids.length };
    },
    async scanDocument(text) {
      const ids = tokenizer.encode(validateText(text), { add_special_tokens: false });
      const windows = planTestsavantWindows(ids), results = [];
      for (const window of windows) results.push({ start: window.start, end: window.end,
        tokens: window.ids.length, ...await score(window.ids) });
      const top = results.reduce((best, row) => row.injectionScore > best.injectionScore ? row : best);
      return { label: top.label, score: top.score, injectionScore: top.injectionScore, tokens: ids.length,
        coverage: "complete", windows: results, aggregation: "maximum-window-score" };
    },
    async close() { if (!closed) { closed = true; await session.release(); } },
  };
}
