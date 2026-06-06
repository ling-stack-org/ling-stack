import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { CliError, errorMessage } from "../errors.js";

export interface RunPromptInputOptions {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly positionals: readonly string[];
  readonly stdin: NodeJS.ReadStream;
  readonly fileBaseCwd: string;
}

export interface RunPromptInputResult {
  readonly prompt: string;
  readonly primarySource:
    | "prompt"
    | "prompt-file"
    | "stdin-flag"
    | "positional"
    | "stdin-pipe";
  readonly appendedStdin: boolean;
}

type PrimarySource =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "prompt-file"; readonly path: string }
  | { readonly kind: "stdin-flag" }
  | { readonly kind: "positional"; readonly text: string };

export async function readRunPromptInput(options: RunPromptInputOptions): Promise<RunPromptInputResult> {
  const primarySource = buildPrimarySource(options);
  const stdinIsPiped = options.stdin.isTTY !== true;
  const explicitStdin = primarySource?.kind === "stdin-flag";
  const shouldReadStdin = explicitStdin || stdinIsPiped;
  const stdinText = shouldReadStdin ? await readStdinUtf8(options.stdin) : undefined;

  let primaryText: string;
  let source: RunPromptInputResult["primarySource"];
  if (primarySource?.kind === "prompt") {
    primaryText = primarySource.text;
    source = "prompt";
  } else if (primarySource?.kind === "prompt-file") {
    primaryText = await readFileUtf8(resolve(options.fileBaseCwd, primarySource.path), "prompt file");
    source = "prompt-file";
  } else if (primarySource?.kind === "stdin-flag") {
    primaryText = stdinText ?? "";
    source = "stdin-flag";
  } else if (primarySource?.kind === "positional") {
    primaryText = primarySource.text;
    source = "positional";
  } else if (stdinText !== undefined) {
    primaryText = stdinText;
    source = "stdin-pipe";
  } else {
    throw new CliError(2, "missing_prompt", "ling-stack run requires prompt text, --prompt <text>, --prompt-file <path>, or stdin.");
  }

  const trimmedPrimary = primaryText.trim();
  if (!trimmedPrimary) {
    throw new CliError(2, "missing_prompt", "ling-stack run prompt is empty.");
  }

  const shouldAppendStdin = stdinText !== undefined && stdinText.length > 0 && !explicitStdin && primarySource !== undefined;
  return {
    prompt: shouldAppendStdin ? composePromptWithStdin(trimmedPrimary, stdinText) : trimmedPrimary,
    primarySource: source,
    appendedStdin: shouldAppendStdin,
  };
}

function buildPrimarySource(options: RunPromptInputOptions): PrimarySource | undefined {
  if (options.positionals.includes("-") && !(options.positionals.length === 1 && options.positionals[0] === "-")) {
    throw new CliError(2, "ambiguous_prompt", "Positional '-' cannot be combined with other prompt text.");
  }

  const sources: PrimarySource[] = [];
  if (options.prompt !== undefined) {
    sources.push({ kind: "prompt", text: options.prompt });
  }
  if (options.promptFile !== undefined) {
    sources.push(options.promptFile === "-" ? { kind: "stdin-flag" } : { kind: "prompt-file", path: options.promptFile });
  }
  if (options.positionals.length === 1 && options.positionals[0] === "-") {
    sources.push({ kind: "stdin-flag" });
  } else if (options.positionals.length > 0) {
    sources.push({ kind: "positional", text: options.positionals.join(" ") });
  }

  if (sources.length > 1) {
    throw new CliError(2, "ambiguous_prompt", "Use only one prompt source: --prompt, --prompt-file, positional text, or stdin.");
  }
  return sources[0];
}

function composePromptWithStdin(primaryPrompt: string, stdinText: string): string {
  if (stdinText.length === 0) {
    return primaryPrompt;
  }
  const stdinBlock = stdinText.endsWith("\n") ? stdinText : `${stdinText}\n`;
  return `${primaryPrompt}\n\n<stdin>\n${stdinBlock}</stdin>`;
}

async function readFileUtf8(filePath: string, label: string): Promise<string> {
  try {
    return decodeUtf8(await readFile(filePath), label);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(2, "file_read_error", `Cannot read ${label} ${filePath}: ${errorMessage(error)}`);
  }
}

async function readStdinUtf8(stdin: NodeJS.ReadStream): Promise<string> {
  try {
    return decodeUtf8(await readStreamBytes(stdin), "stdin");
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(2, "stdin_read_error", `Cannot read stdin: ${errorMessage(error)}`);
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.startsWith("\uFEFF") ? text.slice(1) : text;
  } catch (error) {
    throw new CliError(2, "invalid_prompt_encoding", `${label} must be valid UTF-8: ${errorMessage(error)}`);
  }
}

function readStreamBytes(stream: NodeJS.ReadStream): Promise<Buffer> {
  return new Promise((resolveBytes, rejectBytes) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once("error", rejectBytes);
    stream.once("end", () => {
      resolveBytes(Buffer.concat(chunks));
    });
  });
}
