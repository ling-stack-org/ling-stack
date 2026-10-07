// Required negative acceptance tests. Currently fail on T2-A; never count the positive smoke as full safety proof.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, linkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { compileExecutionSandboxPolicy, createDefaultApprovalPolicy, resolveSessionRunPolicy } from "../../../packages/core/dist/index.js";
import { MACOS_SYSTEM_READ_ROOTS } from "../../../packages/daemon/dist/runtime/sandbox/macos-seatbelt-profile.js";
import { macosSandboxCommandFingerprint, prepareMacosSandboxCommand, readMacosSandboxBackendIdentity, signalMacosSandboxProcessGroup } from "../../../packages/daemon/dist/runtime/sandbox/macos-native-command.js";
const root = mkdtempSync("/private/tmp/ling-macos-boundary-");
const workspace=join(root,"workspace"), temporaryRoot=join(root,"scratch"), outside=join(root,"outside");
for(const path of [workspace,temporaryRoot,outside]) mkdirSync(path,{mode:0o700});
const external=join(outside,"sentinel.txt"); writeFileSync(external,"KEEP_TEST_SENTINEL",{flag:"wx"});
linkSync(external,join(workspace,"existing-hardlink.txt"));
const node=realpathSync(process.execPath);
function prepare(code) {
  const command={kind:"argv",argv:[node,"-e",code]}, now=new Date().toISOString();
  const policy=compileExecutionSandboxPolicy({now,platform:"darwin",tool:"bash",workspaceRoot:workspace,cwd:workspace,temporaryRoot,
    runtimeReadRoots:[...MACOS_SYSTEM_READ_ROOTS,dirname(node)],deniedReadRoots:[outside],protectedWriteRoots:[],
    backend:readMacosSandboxBackendIdentity(),grants:[],
    binding:{workspaceId:"probe",runId:"run",workUnitId:"unit",attemptId:"attempt",runtimeInstanceId:"fixture",fencingToken:"1",toolCallId:"probe",operationHash:macosSandboxCommandFingerprint(command,workspace,temporaryRoot)},
    policy:resolveSessionRunPolicy({workspacePolicy:createDefaultApprovalPolicy("probe",now),authorizationMode:"always",workspaceAccessMode:"workspace_write"}).snapshot});
  return prepareMacosSandboxCommand({policy,command});
}
async function run(prepared) {
  const child=prepared.spawn(()=>{});let stdout="",stderr="";
  child.stdout.on("data",b=>{stdout+=b});child.stderr.on("data",b=>{stderr+=b});
  const timer=setTimeout(()=>{try{signalMacosSandboxProcessGroup(child,"SIGKILL")}catch{}},5000);
  try{const [code,signal]=await once(child,"close");return {code,signal,stdout,stderr};}finally{clearTimeout(timer)}
}
const hardlink=await run(prepare("try{require('node:fs').writeFileSync('existing-hardlink.txt','MUTATED_TEST_SENTINEL');console.log('write_allowed')}catch(e){console.log(e.code);process.exitCode=7}"));
const hardlinkWriteDenied=readFileSync(external,"utf8")==="KEEP_TEST_SENTINEL";
console.log(JSON.stringify({case:"preexisting_hardlink",hardlinkWriteDenied,...hardlink,fixture:root}));
const prepared=prepare("try{const cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1800)'],{detached:true,stdio:'ignore'});c.on('error',e=>{console.log('denied:'+e.code);process.exitCode=7});console.log('CHILD='+c.pid);c.unref();setTimeout(()=>process.exit(0),4000)}catch(e){console.log('denied:'+e.code);process.exitCode=7}");
const child=prepared.spawn(()=>{});let stdout="";
const closed=once(child,"close");
const started=new Promise(resolve=>child.stdout.on("data",b=>{stdout+=b;const match=/CHILD=(\d+)\n/.exec(stdout);if(match)resolve(Number(match[1]));if(stdout.includes("denied:"))resolve(null)}));
let timer;
const pid=await Promise.race([started,closed.then(()=>null),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("probe did not report child")),2000)})]).finally(()=>clearTimeout(timer));
try { signalMacosSandboxProcessGroup(child,"SIGTERM"); } catch {}
await closed;
const alive=()=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch(e){if(e.code==="ESRCH")return false;throw e}};
const survived=alive();
for(let n=0;n<100&&alive();n++)await new Promise(r=>setTimeout(r,25));
console.log(JSON.stringify({case:"detached_descendant",created:!!pid,survivedGroupCancellation:survived,selfExpired:!alive(),declaredProof:prepared.descendantStopProof}));
const violations = [];
if (!hardlinkWriteDenied) violations.push("preexisting hardlink changed an external protected sentinel");
if (survived) violations.push("detached descendant survived process-group cancellation");
assert.ok(violations.length === 0, violations.join("; "));
