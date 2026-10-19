/** ACP partial updates replace supplied fields; nullable presentation fields leave prior values intact. */
export function mergeAcpToolObservation(previous: Readonly<Record<string, unknown>> | undefined,
  update: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const value: Record<string, unknown> = { status: "pending", ...previous, ...update };
  for (const field of ["status", "title", "kind", "name", "content", "locations"] as const) {
    if (update[field] == null) {
      if (previous?.[field] !== undefined) value[field] = previous[field];
      else if (field === "status") value.status = "pending";
      else delete value[field];
    }
  }
  return value;
}
