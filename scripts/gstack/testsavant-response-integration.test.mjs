import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestsavantClient } from "./testsavant-client.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const stage = process.env.LING_GSTACK_RESOURCE_STAGE;
test("malformed worker verdicts reject and reap the actual child rather than becoming safe results", {
  skip: !stage && "requires pinned adjacent Node and managed lease", timeout: 30000,
}, async t => {
  const work = await mkdtemp(join(tmpdir(), "ling-testsavant-responses-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const base = { layer: "testsavant_content", verdict: "safe", confidence: 0,
    meta: { label: "SAFE", safeScore: 0.99, tokens: 1, windows: 1, coverage: "complete",
      aggregation: "maximum-window-score", upstreamVerdict: "safe" } };
  const mutations = [v => { delete v.meta.label; }, v => { v.confidence = 0.99; },
    v => { v.meta.windows = 0; }, v => { v.meta.tokens = 4097; },
    v => { v.meta.safeScore = null; }, v => { v.meta.upstreamVerdict = "block"; },
    v => { v.meta.label = "INJECTION"; delete v.meta.safeScore; v.confidence = 0.99; },
    v => { v.meta.label = "INJECTION"; delete v.meta.safeScore; v.confidence = 0.8;
      v.meta.upstreamVerdict = "log_only"; },
    v => { v.meta.upstreamVerdict = { toString: null, valueOf: null }; }];
  for (const [index, mutate] of mutations.entries()) {
    const verdict = structuredClone(base); mutate(verdict);
    const entry = join(work, `${index}.mjs`);
    await writeFile(entry, `process.stdin.once("data",bytes=>{const req=JSON.parse(bytes);process.stdout.write(JSON.stringify({id:req.id,ok:true,networkAudit:{pid:process.pid,attempts:0},verdict:${JSON.stringify(verdict)}})+"\\n")});process.stdin.resume();\n`);
    const children = [];
    const client = createTestsavantClient({ runtimeRoot: join(stage, "runtime"), modelRoot: work, entry,
      nodeChecksum: "sha256:5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c",
      entryChecksum: (await readGstackClosureFileRecord(entry)).checksum,
      env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      spawnProcess: (...args) => { const child = spawn(...args); children.push(child); return child; } });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(client.scan("fixture"), /verdict_invalid/, `case ${index}`);
        const child = children.at(-1);
        for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(child.exitCode !== null || child.signalCode !== null, "invalid result must reap before explicit close");
      }
      await assert.rejects(client.scan("fixture"), /circuit_open/);
      assert.equal(children.length, 3);
    }
    finally { await client.close(); }
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
});

test("null and scalar response envelopes reject without terminating the host", {
  skip: !stage && "requires pinned adjacent Node and managed lease", timeout: 30000,
}, async t => {
  const work = await mkdtemp(join(tmpdir(), "ling-testsavant-envelopes-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  for (const value of [null, [], 1, "invalid"]) {
    const entry = join(work, "worker.mjs"), host = join(work, "host.mjs");
    await writeFile(entry, `process.stdin.once("data",()=>process.stdout.write(${JSON.stringify(JSON.stringify(value) + "\n")}));process.stdin.resume();\n`);
    const options = { runtimeRoot: join(stage, "runtime"), modelRoot: work, entry,
      nodeChecksum: "sha256:5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c",
      entryChecksum: (await readGstackClosureFileRecord(entry)).checksum };
    await writeFile(host, `import assert from "node:assert/strict";import{spawn}from"node:child_process";
      import{createTestsavantClient}from${JSON.stringify(new URL("testsavant-client.mjs", import.meta.url).href)};
      const children=[];const client=createTestsavantClient({...${JSON.stringify(options)},spawnProcess:(...args)=>{
        const child=spawn(...args);children.push(child);return child}});
      try{await assert.rejects(client.scan("fixture"),/protocol_invalid/)}finally{await client.close()}
      assert.equal(children.length,1);assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null));
      console.log("host-alive-worker-reaped");\n`);
    const run = spawnSync(process.execPath, [host], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "host-alive-worker-reaped");
  }
});

test("input-budget rejections preserve warm workers and never clear genuine circuit failures", {
  skip: !stage && "requires pinned adjacent Node and managed lease", timeout: 30000,
}, async t => {
  const work = await mkdtemp(join(tmpdir(), "ling-testsavant-budget-protocol-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const entry = join(work, "worker.mjs");
  await writeFile(entry, `import{createInterface}from"node:readline";
    for await(const line of createInterface({input:process.stdin})){
      const req=JSON.parse(line),budget=req.text==="long";
      process.stdout.write(JSON.stringify({id:req.id,ok:false,error:budget?"testsavant_token_budget_exceeded":"testsavant_output_invalid",
        networkAudit:{pid:process.pid,attempts:0}})+"\\n");}
  `);
  const children = [];
  const client = createTestsavantClient({ runtimeRoot: join(stage, "runtime"), modelRoot: work, entry,
    nodeChecksum: "sha256:5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c",
    entryChecksum: (await readGstackClosureFileRecord(entry)).checksum,
    spawnProcess: (...args) => { const child = spawn(...args); children.push(child); return child; } });
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(client.scan("fault"), /unavailable/);
    for (let i = 0; i < 3; i++) await assert.rejects(client.scan("long"), /token_budget_exceeded/);
    assert.equal(children.length, 3);
    assert.equal(children.at(-1).exitCode, null);
    await assert.rejects(client.scan("fault"), /unavailable/);
    await assert.rejects(client.scan("fault"), /circuit_open/);
    assert.equal(children.length, 3);
  } finally { await client.close(); }
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});
