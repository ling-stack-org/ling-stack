import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { DarwinLockedUseNativeClient } from "../dist/main/locked-computer-control/darwin-locked-use-client.js";
import { sessionDigest, taskGrant } from "./locked-use-fixtures.ts";

const signal = () => new AbortController().signal;
const target = { toolName: "click", processID: 321 } as const;
const session = { platform: "darwin", sessionBindingDigest: sessionDigest, sessionActive: true, sessionLocked: true };
function fixture(t: TestContext, handler = "reply({active:true})") {
  let verifications = 0;
  let revoked = 0;
  const client = new DarwinLockedUseNativeClient({
    helperPath: "/fixture/native-client",
    async verifyHelper() { verifications += 1; },
    onRevoked() { revoked += 1; },
    spawn() {
      return spawn(process.execPath, ["--input-type=module", "-e", `
        import { createInterface } from 'node:readline';
        const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
        createInterface({input:process.stdin}).on('line', line => {
          const request = JSON.parse(line);
          const reply = result => emit({requestId:request.requestId,ok:true,result});
          if(request.command==='session') return reply(${JSON.stringify(session)});
          if(request.command==='identity') return reply({status:'verified'});
          if(request.command==='end') return reply({ended:true});
          if(request.command==='provider-attach') return reply({attached:true});
          ${handler}
        });
      `], { stdio: ["pipe", "pipe", "pipe"] });
    },
  });
  t.after(() => client.close());
  return { client, verifications: () => verifications, revoked: () => revoked };
}

test("native client verifies once, binds one task and refuses overlapping actions or early release", async (t) => {
  const fx = fixture(t);
  assert.deepEqual(await fx.client.readSession(signal()), session);
  await fx.client.verifyIdentity({ requestId: "auth", platform: "darwin", localizedReason: "Authorize task", signal: signal() });
  await fx.client.begin(taskGrant(), 4, signal());
  await assert.rejects(fx.client.beginAction(signal(), target), /provider_not_registered/u);
  await fx.client.attachProvider(321, signal());
  await fx.client.beginAction(signal(), target);
  await assert.rejects(fx.client.beginAction(signal(), target), /action_in_flight/u);
  await assert.rejects(fx.client.finishAction(signal(), { ...target, processID: 322 }), /action_target_changed/u);
  await assert.rejects(fx.client.end(), /provider_not_quiesced/u);
  await fx.client.finishAction(signal(), target);
  await fx.client.check(signal());
  assert.equal(fx.verifications(), 1);
  await fx.client.end();
  assert.equal(fx.client.ownsManagedSession, false);
  assert.equal(fx.revoked(), 0);
});

test("native revocation fences the task while retaining cleanup ownership until confirmed release", async (t) => {
  const fx = fixture(t, "if(request.command==='check') {emit({event:'revoked'});emit({event:'revoked'});} reply({active:true});");
  await fx.client.begin(taskGrant(), 4, signal());
  await assert.rejects(fx.client.check(signal()), /authority_expired/u);
  assert.equal(fx.revoked(), 1);
  assert.equal(fx.client.ownsManagedSession, true);
  await assert.rejects(fx.client.beginAction(signal(), target));
  await fx.client.end();
  assert.equal(fx.client.ownsManagedSession, false);
});

test("native denial prevents dispatch and still permits an explicit post-drain end", async (t) => {
  const fx = fixture(t, "if(request.command==='action-begin') emit({requestId:request.requestId,ok:false,reason:'denied'}); else reply({active:true});");
  await fx.client.begin(taskGrant(), 4, signal());
  await fx.client.attachProvider(321, signal());
  await assert.rejects(fx.client.beginAction(signal(), target), /native_denied/u);
  assert.equal(fx.revoked(), 1);
  await fx.client.end();
  assert.equal(fx.client.ownsManagedSession, false);
});

test("framing errors poison transport and cannot supply native release proof", async (t) => {
  for (const handler of [
    "emit({requestId:'wrong',ok:true,result:{active:true}})",
    "emit({requestId:request.requestId,ok:true,result:{active:true},credential:'forbidden'})",
    "process.stdout.write('x'.repeat(17000))",
    "process.stdout.write('{invalid}\\n')",
    "process.exit(0)",
  ]) {
    const fx = fixture(t, "if(request.command==='begin') reply({active:true}); else {" + handler + "}");
    await fx.client.begin(taskGrant(), 4, signal());
    await assert.rejects(fx.client.check(signal()));
    assert.equal(fx.revoked(), 1);
    assert.equal(fx.client.ownsManagedSession, true);
    await assert.rejects(fx.client.end(), /relock_unconfirmed/u);
  }
});

test("cancellation kills a pending transport and an expired grant never spawns it", async (t) => {
  const fx = fixture(t, "if(request.command==='begin') reply({active:true})");
  await assert.rejects(fx.client.begin(taskGrant(Date.now() - 901_000), 4, signal()), /grant_invalid/u);
  assert.equal(fx.verifications(), 0);
  await fx.client.begin(taskGrant(), 4, signal());
  const controller = new AbortController();
  const checking = fx.client.check(controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(checking, /aborted/u);
  assert.equal(fx.revoked(), 1);
});

test("failed executable verification prevents spawn", async () => {
  let spawned = false;
  const client = new DarwinLockedUseNativeClient({
    helperPath: "/untrusted/client", onRevoked() {},
    async verifyHelper() { throw new Error("signature_rejected"); },
    spawn() { spawned = true; throw new Error("must not spawn"); },
  });
  await assert.rejects(client.readSession(signal()), /signature_rejected/u);
  assert.equal(spawned, false);
  client.close();
});

test("native client registers one exact provider and never treats a PID as action authority", async (t) => {
  const fx = fixture(t, "reply({active:true})");
  assert.throws(() => fx.client.providerHostProcessID, /authority_expired/u);
  const active = fixture(t);
  await active.client.begin(taskGrant(), 4, signal());
  const helper = active.client.providerHostProcessID;
  assert.ok(helper > 0);
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, helper]) {
    await assert.rejects(active.client.attachProvider(pid, signal()), /provider_identity_invalid/u);
  }
  await active.client.attachProvider(321, signal());
  await assert.rejects(active.client.attachProvider(322, signal()), /provider_identity_invalid/u);
  await active.client.beginAction(signal(), target); await active.client.finishAction(signal(), target);
  await active.client.end();
});

test("helper loss can release ownership only after a new verified observer confirms root release", async (t) => {
  for (const released of [false, true]) {
    const fx = fixture(t, `if(request.command==='check') process.exit(0);
      else if(request.command==='release-status') reply({ended:${released}}); else reply({active:true});`);
    await fx.client.begin(taskGrant(), 4, signal());
    await assert.rejects(fx.client.check(signal()), /helper_exited/u);
    if (released) {
      await fx.client.end();
      assert.equal(fx.client.ownsManagedSession, false);
    } else {
      await assert.rejects(fx.client.end(), /relock_unconfirmed/u);
      assert.equal(fx.client.ownsManagedSession, true);
    }
    assert.equal(fx.verifications(), 2);
    assert.equal(fx.revoked(), 1);
  }
});
