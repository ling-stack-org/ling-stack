import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopMobileAccessClient } from "../dist/main/mobile-access/client.js";
import { deriveMobileAccessCsrfToken, deriveMobileAccessManagementCapability } from "../dist/main/mobile-access/authority.js";

test("Desktop streams the selected file to the authenticated loopback artifact endpoint", async t => {
  const folder = await mkdtemp(join(tmpdir(), "ling-desktop-artifact-"));
  const file = join(folder, "project-output.apk");
  const bytes = Buffer.alloc(96 * 1024, 27);
  await writeFile(file, bytes);
  const bridgeToken = "desktop-fixture-authority";
  const capability = deriveMobileAccessManagementCapability(bridgeToken);
  const uploads: { url: string; bytes: Buffer; contentType?: string; capability?: string; csrf?: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    uploads.push({ url: request.url ?? "", bytes: Buffer.concat(chunks), contentType: request.headers["content-type"],
      capability: String(request.headers["x-ling-mobile-management-capability"]), csrf: String(request.headers["x-ling-csrf-token"]) });
    response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "proposed" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(folder, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let selection: string | undefined;
  const client = new DesktopMobileAccessClient({
    daemonBaseUrl: baseUrl, desktopBridgeToken: bridgeToken, pickDeviceArtifact: async () => selection,
  });
  const request = { shareId: "phone-share", expectedRevision: 4, proposalId: "file-offer" };
  assert.equal(await client.offerDeviceArtifact(request), undefined);
  assert.equal(uploads.length, 0);
  selection = file;
  assert.equal((await client.offerDeviceArtifact(request))?.status, "proposed");
  const [upload] = uploads;
  assert.ok(upload);
  const url = new URL(upload.url, baseUrl);
  assert.equal(url.pathname, "/v1/mobile-access/device-collaboration/artifacts");
  assert.deepEqual(Object.fromEntries(url.searchParams), { shareId: "phone-share", expectedRevision: "4", proposalId: "file-offer", name: "project-output.apk" });
  assert.equal(upload.contentType, "application/octet-stream");
  assert.equal(upload.capability, capability);
  assert.equal(upload.csrf, deriveMobileAccessCsrfToken(capability));
  assert.deepEqual(upload.bytes, bytes);
});
