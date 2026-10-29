/** Actual Electron + production preload/IPC/native codec. Isolated local fixture, not packaged acceptance. */
import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root=await realpath(await mkdtemp(join(tmpdir(),'ling-bg-electron-')));
const desktop=fileURLToPath(new URL('..',import.meta.url));
const helper=fileURLToPath(new URL('../../../packages/daemon/dist/native/image-sanitizer/ling-image-sanitizer',import.meta.url));
const bytes=(await readFile(new URL('../../web/e2e/fixtures/fronalpstock-3840.jpg',import.meta.url))).toString('base64');
const main=join(root,'main.cjs'),html=join(root,'index.html');
await writeFile(html,'<!doctype html><title>Background native acceptance fixture</title><p>Isolated native background fixture</p>');
await writeFile(main,`const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(root)});app.whenReady().then(async()=>{
const {DesktopBackgroundRepository}=await import(${JSON.stringify(new URL('../dist/main/backgrounds/background-repository.js',import.meta.url).href)});
const {registerBackgroundIpc}=await import(${JSON.stringify(new URL('../dist/main/backgrounds/background-ipc.js',import.meta.url).href)});
const repository=new DesktopBackgroundRepository(${JSON.stringify(join(root,'backgrounds'))},${JSON.stringify(helper)});await repository.initialize();
const window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(join(desktop,'dist/preload/main-window.cjs'))},nodeIntegration:false,contextIsolation:true,sandbox:true}});
const dispose=registerBackgroundIpc({repository,getMainWindow:()=>window});app.on('will-quit',()=>{dispose();repository.dispose()});await window.loadFile(${JSON.stringify(html)});
}).catch(error=>{console.error(error);app.exit(1)});`);
let app;
async function launch(){app=await electron.launch({args:[main],timeout:15000,executablePath:fileURLToPath(new URL('../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',import.meta.url))});return await app.firstWindow()}
try {
 let page=await launch();
 const result=await page.evaluate(async encoded=>{
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const repo=window.lingDesktop.backgrounds;const initial=await repo.read();if(!initial.ok)throw Error(initial.error);
  const image=await repo.prepare({requestId:'prepare',bytes,fileName:'photo.jpg',mimeType:'image/jpeg'});if(!image.ok)throw Error(image.error);
  if(image.value.asset.width!==2560||image.value.asset.height!==1150||image.value.bytes.length>16*1024*1024)throw Error('photo_normalization_failed');
  const intent={expectedRevision:initial.value.preference.revision,selection:{kind:'local-image',assetId:image.value.asset.assetId},opacity:.6,presentation:{themeId:'ling-journey',focusX:80,focusY:25,paused:true}};
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([intent.expectedRevision,'local-image',image.value.asset.assetId,.6,['ling-journey',80,25,true]])))),b=>b.toString(16).padStart(2,'0')).join('');
  const saved=await repo.commit({...intent,requestId:'commit',payloadDigest:digest});await repo.release('prepare');return saved;
 },bytes);
 assert.equal(result.ok,true);assert.equal(result.value.revision,1);await app.close();app=undefined;
 page=await launch();const restored=await page.evaluate(()=>window.lingDesktop.backgrounds.read());assert.equal(restored.ok,true);assert.equal(restored.value.preference.revision,1);assert.ok(restored.value.image);assert.deepEqual(restored.value.preference.profiles['ling-journey'],{opacity:.6,focusX:80,focusY:25,paused:true});
 const cleared=await page.evaluate(async()=>{const repo=window.lingDesktop.backgrounds;const payloadDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([1,'none',null,.6])))),b=>b.toString(16).padStart(2,'0')).join('');return repo.commit({requestId:'clear',expectedRevision:1,selection:{kind:'none'},opacity:.6,payloadDigest})});assert.equal(cleared.ok,true);
 await app.close();app=undefined;page=await launch();const final=await page.evaluate(()=>window.lingDesktop.backgrounds.read());assert.equal(final.value.preference.selection.kind,'none');assert.equal(final.value.preference.revision,2);assert.deepEqual(await readdir(join(root,'backgrounds')),['settings.json']);
 for(const format of ['mp4','webm']) {
  const encoded=(await readFile(new URL(`../../web/e2e/fixtures/dynamic-wallpaper.${format}`,import.meta.url))).toString('base64');
  const playback=await page.evaluate(async({encoded,format})=>{
   const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
   const video=document.createElement('video');video.muted=true;video.loop=true;video.playsInline=true;
   const url=URL.createObjectURL(new Blob([bytes],{type:`video/${format}`}));video.src=url;document.body.append(video);
   try {
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('metadata_timeout')),5000);video.onloadedmetadata=()=>{clearTimeout(timeout);resolve()};video.onerror=()=>{clearTimeout(timeout);reject(Error('decode_failed'))}});
    const result=await window.lingDesktop.backgrounds.prepare({requestId:`video-${format}`,bytes,fileName:`wallpaper.${format}`,mimeType:`video/${format}`,width:video.videoWidth,height:video.videoHeight,duration:video.duration});
    if(!result.ok)throw Error(result.error);
    if(result.value.asset.kind!=='video'||result.value.bytes.length!==bytes.length)throw Error('video_roundtrip_failed');
    await video.play();await new Promise(resolve=>setTimeout(resolve,250));const progressed=video.currentTime>0;
    video.pause();const paused=video.paused;await window.lingDesktop.backgrounds.release(`video-${format}`);
    return {format,progressed,paused,width:video.videoWidth,height:video.videoHeight};
   }finally{video.pause();video.remove();URL.revokeObjectURL(url)}
  },{encoded,format});
  assert.equal(playback.progressed,true);assert.equal(playback.paused,true);
 }
 process.stdout.write(JSON.stringify({pass:true,surface:'actual Electron + production preload/IPC/native codec',platform:process.platform,arch:process.arch,packaged:false,checks:['profile commit/restart','prepare','commit','complete process restart','restore','clear','second restart','gc','MP4/WebM IPC + actual decode/play/pause']})+'\n');
}finally{await app?.close();await rm(root,{recursive:true,force:true})}
