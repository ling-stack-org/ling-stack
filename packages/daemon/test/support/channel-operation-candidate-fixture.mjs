// Static model candidates only. Every semantic field is supplied by the test;
// this helper never parses a user request or reconstructs operation ownership.
export function fileOperationCandidate({ id, kind = "file_create", sourceQuote, path,
  targetSourceItemId, contentSource, dependsOn = [], owner = { kind: "host_default" } }) {
  return {
    id, kind, targetKind: "file", required: true, dependsOn, owner, sourceQuote,
    ...(path === undefined ? {} : { target: { path, sourceQuote: path,
      ...(targetSourceItemId ? { sourceItemId: targetSourceItemId } : {}) } }),
    ...(contentSource ? { contentSource } : {}),
  };
}

export function commandOperationCandidate({ id = "run_command", sourceQuote, command,
  inputs = [], dependsOn = [], owner = { kind: "host_default" } }) {
  return {
    id, kind: "run_command", targetKind: "command", required: true, dependsOn, owner, sourceQuote,
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(command === undefined ? {} : { command: { text: command, sourceQuote: command } }),
  };
}
