/** Keep fragments within a stream adjacent, but never glue stdout to stderr. */
export function formatCommandOutputTail(
  chunks: readonly { readonly stream: "stdout" | "stderr"; readonly text: string }[],
): string {
  const visible = chunks.filter((chunk) => chunk.text.length > 0);
  if (visible.length === 0) return "";
  if (visible.every((chunk) => chunk.stream === visible[0]?.stream)) {
    return visible.map((chunk) => chunk.text).join("");
  }
  let formatted = "";
  let activeStream: "stdout" | "stderr" | undefined;
  for (const chunk of visible) {
    if (chunk.stream !== activeStream) {
      if (formatted && !formatted.endsWith("\n")) formatted += "\n";
      formatted += `${chunk.stream}:\n`;
      activeStream = chunk.stream;
    }
    formatted += chunk.text;
  }
  return formatted;
}
