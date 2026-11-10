import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, realpath, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DesktopBackgroundRepository } from '../dist/main/backgrounds/background-repository.js';
import { backgroundPayloadDigest } from '@ling-stack/ui-react/theme';
const png=new Uint8Array(await readFile(new URL('../../../packages/daemon/native/image-sanitizer/fixtures/source.png',import.meta.url)));
const mp4=new Uint8Array(await readFile(new URL('../../web/e2e/fixtures/dynamic-wallpaper.mp4',import.meta.url)));
const webm=new Uint8Array(await readFile(new URL('../../web/e2e/fixtures/dynamic-wallpaper.webm',import.meta.url)));
const repo=(root,checkpoint)=>new DesktopBackgroundRepository(root,'/unused',async bytes=>new Uint8Array(bytes),checkpoint);
const prepare=(r,id='prepare')=>r.prepare({requestId:id,bytes:png,fileName:'a.png',mimeType:'image/png'});
async function request(revision,selection,id='commit',opacity=.6) {const input={expectedRevision:revision,selection,opacity};return {...input,requestId:id,payloadDigest:await backgroundPayloadDigest(input)};}
async function temporary(t) { const dir=await mkdtemp(join(tmpdir(),'ling-bg-')); t.after(()=>rm(dir,{recursive:true,force:true})); return realpath(dir); }
test('BG-10/11/12 native commit/receipt, clear, delayed retry and revision concurrency',async t=>{
 const dir=await temporary(t), root=join(dir,'backgrounds'),r=repo(root);await r.initialize();
 const image=await prepare(r),a=await request(0,{kind:'local-image',assetId:image.asset.assetId});
 assert.equal((await r.commit(a)).revision,1);assert.equal((await r.commit(a)).revision,1);
 const wrong={...a,opacity:.75};wrong.payloadDigest=await backgroundPayloadDigest(wrong);await assert.rejects(()=>r.commit(wrong),{code:'invalid-request'});
 const [b,c]=await Promise.all([request(1,{kind:'none'},'clear'),request(1,{kind:'none'},'other')]);
 const results=await Promise.allSettled([r.commit(b),r.commit(c)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(()=>r.commit(a),{code:'conflict'});assert.equal((await repo(root).read()).preference.selection.kind,'none');
 assert.deepEqual(await readdir(root),['settings.json']);
});
test('BG-14 staged / published assets and config survive crash checkpoints',async t=>{
 const dir=await temporary(t);
 for(const stage of ['asset-staged','asset-published','config-staged','config-published']) {
  const root=join(dir,stage);
  const worker=`import {DesktopBackgroundRepository} from ${JSON.stringify(new URL('../dist/main/backgrounds/background-repository.js',import.meta.url).href)};
   import {readFile} from 'node:fs/promises';import {backgroundPayloadDigest} from '@ling-stack/ui-react/theme';
   const root=process.argv[1],stage=process.argv[2],bytes=new Uint8Array(await readFile(process.argv[3]));
   const r=new DesktopBackgroundRepository(root,'/unused',async bytes=>bytes,s=>{if(s===stage)process.exit(93)});
   await r.initialize();const image=await r.prepare({requestId:'prepare',bytes,fileName:'a.png',mimeType:'image/png'});
   const input={expectedRevision:0,selection:{kind:'local-image',assetId:image.asset.assetId},opacity:.6};
   await r.commit({...input,requestId:stage,payloadDigest:await backgroundPayloadDigest(input)});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',worker,root,stage,new URL('../../../packages/daemon/native/image-sanitizer/fixtures/source.png',import.meta.url).pathname],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(child.status,93,child.stderr);
  const reopened=repo(root);await reopened.initialize();const snapshot=await reopened.read();
  assert.equal(snapshot.preference.selection.kind,stage==='config-published'?'local-image':'none');
  const files=await readdir(root);assert.equal(files.some(x=>x.startsWith('.stage-')),false);
  assert.equal(files.filter(x=>x.endsWith('.png')).length,stage==='config-published'?1:0);
 }
});
test('BG-13/15 native symlinks, corrupt assets and unrelated files are preserved',async t=>{
 const dir=await temporary(t),root=join(dir,'backgrounds'),r=repo(root);await r.initialize();
 const image=await prepare(r);await r.commit(await request(0,{kind:'local-image',assetId:image.asset.assetId}));
 await writeFile(join(root,'unrelated.txt'),'keep');
 await writeFile(join(root,image.asset.assetId+'.png'),'corrupt');
 const state=await repo(root).read();assert.equal(state.resourceError,'corrupt');assert.equal(state.preference.revision,1);
 await r.commit(await request(1,{kind:'none'},'clear'));
 assert.equal(await readFile(join(root,'unrelated.txt'),'utf8'),'keep');
 const outside=join(dir,'outside');await mkdir(outside);await symlink(outside,join(dir,'linked'));
 await assert.rejects(()=>repo(join(dir,'linked')).initialize());
 await assert.rejects(()=>repo(join(dir,'linked','nested')).initialize());assert.deepEqual(await readdir(outside),[]);
 await symlink(join(root,'unrelated.txt'),join(root,'settings-copy.json'));
});

test('BG-11/16 native MP4 and WebM wallpapers use bounded original bytes and restore after restart',async t=>{
 for(const media of [{bytes:mp4,name:'wallpaper.mp4',mimeType:'video/mp4',extension:'mp4'},{bytes:webm,name:'wallpaper.webm',mimeType:'video/webm',extension:'webm'}]) {
  const dir=await temporary(t),root=join(dir,'backgrounds'),r=repo(root);await r.initialize();
  const video=await r.prepare({requestId:'video',bytes:media.bytes,fileName:media.name,mimeType:media.mimeType,width:320,height:180,duration:2});
  assert.equal(video.asset.kind,'video');assert.equal(video.asset.mimeType,media.mimeType);
  const saved=await r.commit(await request(0,{kind:'local-video',assetId:video.asset.assetId},'video-commit'));
  assert.equal(saved.selection.kind,'local-video');
  const restored=await repo(root);await restored.initialize();const snapshot=await restored.read();
  assert.equal(snapshot.image?.asset.kind,'video');assert.equal(snapshot.image?.asset.width,320);assert.equal(snapshot.image?.bytes.length,media.bytes.length);
  assert.deepEqual((await readdir(root)).sort(),[`${video.asset.assetId}.json`,`${video.asset.assetId}.${media.extension}`,'settings.json'].sort());
 }
});

test('BG-H3 profile commit is atomic with media, survives restart and rejects stale windows',async t=>{
 const dir=await temporary(t),root=join(dir,'backgrounds'),r=repo(root);await r.initialize();
 const image=await prepare(r);
 const input={expectedRevision:0,selection:{kind:'local-image',assetId:image.asset.assetId},opacity:.8,presentation:{themeId:'ling-journey',focusX:80,focusY:25,paused:true}};
 const a={...input,requestId:'profile',payloadDigest:await backgroundPayloadDigest(input)};
 const saved=await r.commit(a);assert.deepEqual((await r.commit(a)).profiles,saved.profiles);
 const restarted=repo(root);await restarted.initialize();
 assert.deepEqual((await restarted.read()).preference.profiles['ling-journey'],{opacity:.8,focusX:80,focusY:25,paused:true});
 const other={...input,expectedRevision:1,presentation:{themeId:'ling-dark',focusX:20,focusY:50,paused:false}};
 const b={...other,requestId:'second-theme',payloadDigest:await backgroundPayloadDigest(other)};
 const next=await restarted.commit(b);assert.deepEqual(next.profiles['ling-journey'],saved.profiles['ling-journey']);
 await assert.rejects(()=>r.commit({...a,requestId:'stale-window'}),{code:'conflict'});
 assert.equal((await restarted.read()).image.asset.assetId,image.asset.assetId);
});
