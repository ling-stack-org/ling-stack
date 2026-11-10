import { stripVTControlCharacters } from "node:util";
import type { ExecutionAction, TerminalReportEvidenceOperation } from "@ling-stack/core";
import { redactEvidenceText } from "./context-processing/evidence.js";

/** Reuse accepted atomic action facts. Never read artifacts or infer a receipt. */
export function projectTerminalReportCommandEvidence(
  action: ExecutionAction,
  maxCharacters: number,
): TerminalReportEvidenceOperation["commandEvidence"] {
  const evidence = action.commandEvidence;
  if (!evidence) return undefined;
  const clean = (text: string) => redactEvidenceText(stripVTControlCharacters(text));
  const command = clean(evidence.command);
  const raw = (stream: "stdout" | "stderr") => evidence.outputTail
    .filter(chunk => chunk.stream === stream).map(chunk => chunk.text).join("");
  const stdoutRaw = raw("stdout"), stderrRaw = raw("stderr");
  // Redact whole streams before cutting them: chunk/budget boundaries must not
  // turn a recognized credential into an unrecognized visible prefix.
  const stdout = clean(stdoutRaw), stderr = clean(stderrRaw);
  const stdoutBudget = stderr.length
    ? Math.min(stdout.length, Math.ceil(maxCharacters / 2))
    : maxCharacters;
  const stderrBudget = maxCharacters - Math.min(stdout.length, stdoutBudget);
  const stdoutPreview = stdout.slice(0, stdoutBudget);
  const stderrPreview = stderr.slice(0, stderrBudget);
  return {
    command: command.slice(0, maxCharacters),
    commandTruncated: command.length > maxCharacters,
    cwd: evidence.cwd ? clean(evidence.cwd).slice(0, maxCharacters) : undefined,
    outcome: evidence.outcome,
    exitCode: evidence.exitCode,
    signal: evidence.signal ? clean(evidence.signal).slice(0, maxCharacters) : undefined,
    timedOut: evidence.timedOut,
    cancelled: evidence.cancelled,
    durationMs: evidence.durationMs,
    stdout: stdoutPreview,
    stderr: stderrPreview,
    outputTruncated: evidence.outputTruncated || stdoutPreview.length < stdout.length || stderrPreview.length < stderr.length
      || evidence.outputByteCount > Buffer.byteLength(stdoutRaw + stderrRaw),
    outputRedacted: evidence.outputTail.some(chunk => chunk.redacted)
      || stdout !== stripVTControlCharacters(stdoutRaw) || stderr !== stripVTControlCharacters(stderrRaw),
  };
}
