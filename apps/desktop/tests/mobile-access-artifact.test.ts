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

test("Desktop lists and shares a retained build by job ID through the management bridge", async () => {
  const desktopBridgeToken = "build-fixture-authority";
  const managementCapability = deriveMobileAccessManagementCapability(desktopBridgeToken);
  const request = { shareId: "phone-share", expectedRevision: 4, proposalId: "build-offer", buildJobId: "pc-build" };
  const builds = [{ buildJobId: "pc-build", buildId: "debug", name: "test.apk", packageId: "org.example.preview", versionCode: "71",
    digest: "sha256:" + "a".repeat(64), builtAt: "2026-11-23T07:00:00.000Z" }];
  const offer = { status: "proposed", manifest: { proposalId: request.proposalId } };
  const client = new DesktopMobileAccessClient({
    daemonBaseUrl: "http://127.0.0.1:17891", desktopBridgeToken,
    pickDeviceArtifact: async () => assert.fail("a retained build bypassed its job identity"),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v1/mobile-access/device-collaboration/artifacts/from-build");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-ling-mobile-management-capability"), managementCapability);
      if (init?.method === "GET") {
        assert.deepEqual(Object.fromEntries(url.searchParams), { shareId: "phone-share", expectedRevision: "4" });
        return Response.json({ builds });
      }
      assert.equal(init?.method, "POST");
      assert.equal(headers.get("x-ling-csrf-token"), deriveMobileAccessCsrfToken(managementCapability));
      assert.deepEqual(JSON.parse(String(init?.body)), request);
      return Response.json(offer, { status: 201 });
    },
  });
  assert.deepEqual(await client.listDeviceBuildArtifacts({ shareId: request.shareId, expectedRevision: request.expectedRevision }), builds);
  assert.deepEqual(await client.offerDeviceBuildArtifact(request), offer);
});
