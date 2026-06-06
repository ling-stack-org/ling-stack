import { randomUUID } from "node:crypto";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { CliError, errorMessage } from "../errors.js";
import type { RunEventEnvelope } from "./events.js";

export interface LastMessageCollector {
  handleEvent(envelope: RunEventEnvelope): void;
  lastCompletedMessage(): string | undefined;
}

export function createLastMessageCollector(): LastMessageCollector {
  let currentMessage = "";
  let lastCompletedMessage: string | undefined;

  return {
    handleEvent(envelope: RunEventEnvelope): void {
      if (envelope.type === "assistant_text_delta") {
        const text = readString(envelope.data, "text");
        if (text) {
          currentMessage += text;
        }
        return;
      }
      if (envelope.type === "message_end") {
        lastCompletedMessage = currentMessage;
        currentMessage = "";
      }
    },
    lastCompletedMessage(): string | undefined {
      return lastCompletedMessage;
    },
  };
}

export async function validateLastMessageTarget(filePath: string): Promise<void> {
  const parent = dirname(resolve(filePath));
  try {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) {
      throw new CliError(2, "output_parent_missing", `Parent path is not a directory: ${parent}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(2, "output_parent_missing", `Parent directory does not exist for --output-last-message: ${parent}`);
  }
}

export async function writeLastMessageAtomic(filePath: string, text: string): Promise<void> {
  const targetPath = resolve(filePath);
  const parent = dirname(targetPath);
  const tempPath = join(parent, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new CliError(4, "output_write_failed", `Cannot write --output-last-message ${targetPath}: ${errorMessage(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === "string" ? field : undefined;
}
