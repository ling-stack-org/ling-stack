import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const payload = request.payload ?? {};
  if (request.method === "discover") {
    if (payload.connectionRef === "fixture:crash") process.exit(17);
    if (payload.connectionRef === "fixture:hang") continue;
    if (payload.connectionRef === "fixture:malformed") {
      process.stdout.write("null\n");
      continue;
    }
    if (payload.connectionRef === "fixture:over-limit") {
      process.stdout.write("x".repeat(8192));
      continue;
    }
    const profile = {
      device: {
        id: "external-fixture-device", ownerScope: payload.ownerId, displayName: "External fixture device",
        kind: "linux", lifecycleStatus: "identified", profileRevision: "profile-1",
      },
      adapterId: "external-fixture", adapterVersion: "1.0.0", transports: ["local_process"],
      connectionRefs: [String(payload.connectionRef)],
      transportDeployments: [{ transport: "local_process", mode: "target_executor", pairing: "user_confirmation", removal: "remove_target_executor" }],
      profileRevision: "profile-1", source: "adapter",
    };
    process.stdout.write(JSON.stringify({ protocol: 1, requestId: request.requestId, ok: true, result: profile }) + "\n");
  } else if (request.method === "get_capabilities") {
    const snapshot = {
      snapshotId: "external-snapshot-1", deviceId: "external-fixture-device", adapterId: "external-fixture", adapterVersion: "1.0.0",
      contractMajor: 1, connectionRevision: payload.connectionRevision,
      capabilities: [{
        id: "external.inspect", schemaVersion: "1.0", semanticVerb: "device.inspect", inputSchema: {}, outputSchema: {},
        sideEffect: "read_only", approvalClass: "allow", requiredPermissions: [], prerequisites: [], timeoutMs: 5000,
        responseBytesLimit: 4096, idempotency: "request", supportedDeviceKinds: ["linux"], supportedTransports: ["local_process"],
      }],
      observedAt: "2026-11-22T00:00:00.000Z", freshnessUntil: "2026-11-22T00:05:00.000Z",
    };
    process.stdout.write(JSON.stringify({ protocol: 1, requestId: request.requestId, ok: true, result: snapshot }) + "\n");
  } else if (request.method === "execute") {
    const startedAt = "2026-11-22T00:00:00.000Z";
    const action = { actionId: payload.request.actionId, status: "completed", startedAt, finishedAt: startedAt, observationIds: ["external-observation-1"] };
    const observations = [{
      id: "external-observation-1", subjectId: payload.profile.device.id, source: "external-fixture", value: { reachable: true },
      observedAt: startedAt, receivedAt: startedAt, freshnessUntil: "2026-11-22T00:05:00.000Z", quality: "good",
      provenance: ["external-fixture"], redactionClass: "public",
    }];
    process.stdout.write(JSON.stringify({ protocol: 1, requestId: request.requestId, ok: true, result: { action, observations } }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ protocol: 1, requestId: request.requestId, ok: false, error: { code: "unsupported_method" } }) + "\n");
  }
}
