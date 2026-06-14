import { mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { redactSecrets } from "@ling-stack/core";

export interface ExternalArtifactImportInput {
  readonly artifactRoot: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly role: "result" | "stdout" | "stderr" | "artifact";
  readonly filename: string;
  readonly content: string;
  readonly extraSecrets?: readonly (string | undefined)[];
}

export interface ExternalArtifactImportSummary {
  readonly path: string;
  readonly role: ExternalArtifactImportInput["role"];
  readonly bytes: number;
}

export function importExternalAgentArtifact(input: ExternalArtifactImportInput): ExternalArtifactImportSummary {
  const artifactRoot = resolve(input.artifactRoot);
  const dir = resolve(artifactRoot, input.runId, "external-agent", input.toolCallId);
  const path = resolve(dir, safeArtifactFilename(input.filename));
  if (!isWithinRoot(artifactRoot, path)) {
    throw new Error("External artifact path is outside the Ling artifact root.");
  }
  const content = `${String(redactSecrets(input.content, input.extraSecrets ?? []))}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf8");
  return {
    path,
    role: input.role,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

function safeArtifactFilename(filename: string): string {
  const name = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return name || "artifact.txt";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
