const INLINE_EXECUTION_FLAGS = new Set([
  "-c",
  "-cl",
  "-e",
  "-lc",
  "--command",
  "--encodedcommand",
  "--eval",
  "--print",
  "-p",
]);

/**
 * Build the compact command label used by the activity rail.
 *
 * Inline interpreter payloads are intentionally hidden behind an ellipsis so
 * the first word of a quoted script cannot be mistaken for a file or target.
 * The exact command remains available in the disclosure detail.
 */
export function commandTarget(command: string): string {
  const tokens = command.trim().split(/\s+/u);
  const executable = tokens[0]?.replace(/^.*[\\/]/u, "");
  if (!executable) return "";

  const inlineFlag = tokens.slice(1).find((token) => {
    const normalized = token.toLowerCase();
    return INLINE_EXECUTION_FLAGS.has(normalized) || [...INLINE_EXECUTION_FLAGS].some((flag) => normalized.startsWith(`${flag}=`));
  });
  if (inlineFlag) {
    const flag = inlineFlag.split("=", 1)[0];
    return truncateInline(`${executable} ${flag} …`);
  }

  const firstMeaningfulArg = tokens.slice(1).find((token) =>
    !token.startsWith("-") && !token.includes("=") && !/[\\/$]/u.test(token),
  );
  return truncateInline(firstMeaningfulArg ? `${executable} ${firstMeaningfulArg}` : executable);
}

export function truncateInline(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}
