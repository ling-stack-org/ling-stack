import assert from "node:assert/strict";
import test from "node:test";
import { EngineManagementAuthority, engineManagementCsrf } from "../dist/features/execution-engines/authority.js";

const capability = "fixture-root-" + "x".repeat(40);
const origin = "http://127.0.0.1:5175";
const rootHeaders = { authorization: `Bearer ${capability}`, "x-ling-engine-csrf": engineManagementCsrf(capability) };
function request({ headers = {}, peer = "127.0.0.1", method = "GET" } = {}) {
  return { method, headers: { host: "127.0.0.1:17892", ...headers }, socket: { remoteAddress: peer, localPort: 17892 } };
}
function authority(options = {}) {
  return new EngineManagementAuthority({ capability, allowedOrigins: [origin], ...options });
}
function rejected(operation, code) {
  assert.throws(operation, (error) => error.code === code);
}

test("local host traffic still requires the dedicated management capability", () => {
  const auth = authority();
  rejected(() => auth.authorize(request()), "engine_authority_required");
  rejected(() => auth.authorize(request({ headers: { origin } })), "engine_authority_required");
  rejected(() => auth.authorize(request({ headers: { ...rootHeaders, authorization: "Bearer test-mobile-access-capability" } })), "engine_authority_required");
  assert.equal(auth.authorize(request({ headers: rootHeaders })).kind, "host");
  assert.equal(auth.authorize(request({ headers: { ...rootHeaders, origin } })).kind, "host");
});

test("HTTP default-port Host normalization still requires exact loopback and socket port", () => {
  const auth = authority({ allowedOrigins: [] });
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    for (const header of [host, `${host}:80`]) {
      const req = { method: "POST", headers: { ...rootHeaders, host: header, origin: `http://${host}` },
        socket: { remoteAddress: "127.0.0.1", localPort: 80 } };
      assert.equal(auth.authorize(req).kind, "host");
      rejected(() => auth.authorize({ ...req, socket: { ...req.socket, localPort: 8080 } }), "engine_transport_forbidden");
    }
  }
});

test("transport rejects remote peers, forged Host/Origin, browser missing Origin and forwarded headers", () => {
  const auth = authority();
  for (const patch of [
    { peer: "192.168.1.2" },
    { headers: { host: "attacker.test:17892" } },
    { headers: { host: "127.0.0.1:17891" } },
    { headers: { origin: "http://127.0.0.1:5176" } },
    { headers: { origin: `${origin}/` } },
    { headers: { origin: "null" } },
    { headers: { "sec-fetch-mode": "cors" } },
    { headers: { "x-forwarded-for": "127.0.0.1" } },
    { headers: { forwarded: "for=127.0.0.1" } },
    { headers: { "x-forwarded-host": "localhost" } },
  ]) {
    rejected(() => auth.authorize(request({ ...patch, headers: { ...rootHeaders, ...patch.headers } })), "engine_transport_forbidden");
  }
  assert.equal(auth.authorize(request({ peer: "::ffff:127.0.0.1", headers: rootHeaders })).kind, "host");
});

test("all mutation verbs require the authority-specific CSRF proof", () => {
  const auth = authority();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    rejected(() => auth.authorize(request({ method, headers: { authorization: rootHeaders.authorization } })), "engine_csrf_invalid");
    rejected(() => auth.authorize(request({ method, headers: { ...rootHeaders, "x-ling-engine-csrf": "wrong" } })), "engine_csrf_invalid");
    assert.equal(auth.authorize(request({ method, headers: rootHeaders })).kind, "host");
  }
});

test("enrollment is one-use and Origin-bound; scoped Web sessions cannot mint host authority", () => {
  const auth = authority();
  const enrollment = auth.createEnrollment(origin);
  rejected(() => auth.redeemEnrollment(request(), enrollment.code), "engine_enrollment_invalid");
  const session = auth.redeemEnrollment(request({ headers: { origin }, method: "POST" }), enrollment.code);
  const headers = { origin, authorization: `Bearer ${session.token}`, "x-ling-engine-csrf": session.csrfToken };
  assert.equal(auth.authorize(request({ headers, method: "PUT" })).kind, "web");
  rejected(() => auth.authorize(request({ headers: { ...headers, origin: undefined } })), "engine_authority_required");
  rejected(() => auth.redeemEnrollment(request({ headers: { origin }, method: "POST" }), enrollment.code), "engine_enrollment_invalid");
  auth.revokeSession(session.token);
  rejected(() => auth.authorize(request({ headers })), "engine_authority_required");
});

test("enrollment and sessions expire and cannot survive a daemon restart", () => {
  let now = 100_000;
  const auth = authority({ now: () => now });
  const enrollment = auth.createEnrollment(origin);
  now = Date.parse(enrollment.expiresAt);
  rejected(() => auth.redeemEnrollment(request({ headers: { origin } }), enrollment.code), "engine_enrollment_invalid");
  const session = auth.redeemEnrollment(request({ headers: { origin } }), auth.createEnrollment(origin).code);
  const headers = { origin, authorization: `Bearer ${session.token}` };
  rejected(() => authority().authorize(request({ headers })), "engine_authority_required");
  now = Date.parse(session.expiresAt);
  rejected(() => auth.authorize(request({ headers })), "engine_authority_required");
});

test("invalid enrollment attempts are bounded and cannot consume a valid code", () => {
  let now = 100_000;
  const auth = authority({ now: () => now });
  const enrollment = auth.createEnrollment(origin);
  const browser = request({ headers: { origin }, method: "POST" });
  for (let i = 0; i < 8; i++) rejected(() => auth.redeemEnrollment(browser, "wrong"), "engine_enrollment_invalid");
  rejected(() => auth.redeemEnrollment(browser, enrollment.code), "engine_enrollment_rate_limited");
  now += 60_000;
  assert.ok(auth.redeemEnrollment(browser, enrollment.code).token);
});

test("host authorization may enroll an explicit local origin but never a remote or noncanonical one", () => {
  const auth = authority();
  for (const bad of ["https://remote.example", "file://", "null", `${origin}/`, "http://u:p@localhost:5175", "http://localhost:5175/?token=secret"]) {
    rejected(() => auth.createEnrollment(bad), "engine_transport_forbidden");
  }
  const local = "http://localhost:6000";
  const enrollment = auth.createEnrollment(local);
  const session = auth.redeemEnrollment(request({ headers: { origin: local } }), enrollment.code);
  assert.equal(auth.authorize(request({ headers: { origin: local, authorization: `Bearer ${session.token}` } })).kind, "web");
});

test("closing the authority fences even an already-known launch credential", () => {
  const auth = authority();
  auth.close();
  rejected(() => auth.authorize(request({ headers: rootHeaders })), "engine_authority_required");
  rejected(() => auth.createEnrollment(origin), "engine_authority_required");
});

test("native-operation authority is actively cancelled by session revocation, expiry and host shutdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const auth = authority();
  t.after(() => auth.close());
  const enroll = () => auth.redeemEnrollment(request({ headers: { origin } }), auth.createEnrollment(origin).code);
  const first = enroll(), second = enroll();
  const host = auth.lifetime({ kind: "host" });
  const revoked = auth.lifetime({ kind: "web", token: first.token });
  const expired = auth.lifetime({ kind: "web", token: second.token });
  auth.revokeSession(first.token);
  assert.equal(revoked.aborted, true);
  assert.equal(expired.aborted, false);
  t.mock.timers.tick(30 * 60_000);
  assert.equal(expired.aborted, true, "expiry must stop login without another HTTP request");
  assert.equal(host.aborted, false);
  auth.close();
  assert.equal(host.aborted, true);
});
