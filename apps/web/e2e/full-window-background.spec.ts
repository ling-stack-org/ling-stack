import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mockDaemon } from './support/mock-daemon';
import { createBaseState, createChatProvider } from './support/mock-state';
import { installNormalConversationFixture, normalConversationFixtureTitle } from './support/normal-conversation-fixture';
const png = await readFile(new URL('../../../packages/daemon/native/image-sanitizer/fixtures/source.png',import.meta.url));
const photo = await readFile(new URL('./fixtures/fronalpstock-3840.jpg',import.meta.url));
const mp4 = await readFile(new URL('./fixtures/dynamic-wallpaper.mp4',import.meta.url));
const webm = await readFile(new URL('./fixtures/dynamic-wallpaper.webm',import.meta.url));
if(process.env.LING_BACKGROUND_DEMO==='1') test.use({video:{mode:'on',size:{width:1440,height:960}}});
async function prepare(page: Page, native?: 'ready' | 'blocked' | 'pending' | 'error' | 'pi') {
 await page.addInitScript(()=> { localStorage.setItem('ling-stack.locale','en-US');
  const live = new Set<string>(), originalCreate=URL.createObjectURL.bind(URL), originalRevoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=blob=>{const url=originalCreate(blob);live.add(url);return url};
  URL.revokeObjectURL=url=>{live.delete(url);originalRevoke(url)};
  Object.defineProperty(window,'__backgroundUrls',{get:()=>live.size});
 });
 const state=createBaseState({approvalStatus:'expired'});state.providers=[createChatProvider({id:'background-provider',lastCheck:{ok:true,code:'ready',message:'Controlled fixture',checkedAt:'2026-10-19T00:00:00.000Z'}})];
 state.workspaceSettings.defaultProviderPresetId=state.providers[0].id;state.approvals=[];installNormalConversationFixture(state);
 await mockDaemon(page,state);
 await page.route('**/runtime/conversation-execution**',route=>{
  if(native==='pending')return;
  if(native==='error')return route.fulfill({status:503,json:{error:'controlled_native_unavailable'}});
  const selectedNative=native && native!=='pi';
  return route.fulfill({json:{cwd:new URL(route.request().url()).searchParams.get('cwd')??'',status:selectedNative?native:'not_selected',defaultRunnerId:selectedNative?'codex-app-server':'pi',...(selectedNative?{executionBinding:{kind:'native_profile',engineId:'codex-app-server',profileId:'background-test',profileRevision:2,nativeModelId:'test-model'}}:{})}});
 });
 await page.goto('/');
}
async function settings(page: Page) {
 await page.getByRole('complementary',{name:/Sidebar display|侧栏显示/u}).getByRole('button',{name:'Settings'}).click();
 await page.getByLabel('Settings sections').getByRole('button',{name:'Interface preferences',exact:true}).click();
 const section=page.locator('[data-background-settings]');await expect(section).toBeVisible();await expect(section.getByRole('button',{name:'Choose or replace media'})).toBeEnabled();return section;
}
async function select(page: Page, buffer=png, jpeg=false) {
 await page.locator('[data-background-file]').setInputFiles({name:jpeg?'background.jpg':'background.png',mimeType:jpeg?'image/jpeg':'image/png',buffer});
 await expect(page.locator('[data-background-preview]')).toHaveAttribute('data-draft','true');
}
async function apply(page: Page) {await page.getByRole('button',{name:'Apply background',exact:true}).click();await expect(page.locator('[data-background-preview]')).toHaveAttribute('data-draft','false');await expect(page.locator('html')).toHaveAttribute('data-user-background','ready');}
async function setOpacity(page: Page, value: number) {await page.locator('[data-background-opacity]').fill(String(value));}
async function sceneScreenshot(page: Page, testInfo: import('@playwright/test').TestInfo, name: string) {
 const directory=process.env.LING_SCENE_EVIDENCE;
 if(!directory)return page.screenshot({path:testInfo.outputPath(name)});
 await mkdir(directory,{recursive:true});return page.screenshot({path:resolve(directory,name),fullPage:true});
}
function errors(page:Page){const messages:string[]=[];page.on('pageerror',e=>messages.push(e.message));page.on('console',m=>{if(m.type()==='error')messages.push(m.text())});return messages;}

test('BG-03/04/07/08/09/16 preview, persist, themes, protected routes, narrow and clear',async({page},testInfo)=>{
 const failures=errors(page);await prepare(page);const panel=await settings(page);await select(page);
 await expect(page.locator('html')).toHaveAttribute('data-user-background','off');
 await page.getByRole('button',{name:'Cancel preview'}).click();await expect(page.locator('[data-background-preview]')).toHaveAttribute('data-draft','false');
 await select(page);await setOpacity(page,75);await apply(page);
 await expect(panel.locator('[data-background-opacity]')).toHaveValue('75');await expect(panel.getByRole('button',{name:'Apply background',exact:true})).toHaveCount(0);
 await expect(page.locator('[data-background-layer]')).toBeHidden();
 const src=await page.locator('[data-background-layer] img').getAttribute('src');
 await page.locator('[data-theme-option-id="ling-light"]').click();
 await expect(page.locator('[data-background-layer] img')).toHaveAttribute('src',src!);
 await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await expect(page.locator('[data-background-layer]')).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('background-light.png')});
 await page.setViewportSize({width:1170,height:900});await expect(page.locator('[data-background-layer]')).toBeHidden();
 await page.setViewportSize({width:1440,height:960});await expect(page.locator('[data-background-layer]')).toBeVisible();
 await page.emulateMedia({forcedColors:'active'});await expect(page.locator('[data-background-layer]')).toBeHidden();
 await page.emulateMedia({forcedColors:'none'});await expect(page.locator('[data-background-layer]')).toBeVisible();
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-user-background','ready');
 await settings(page);await page.getByRole('button',{name:'Restore default background'}).click();await expect(page.locator('html')).toHaveAttribute('data-user-background','off');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-user-background','off');expect(failures).toEqual([]);
});

test('BG-01/03/04/05/06 official scene themes, thumbnails and custom override',async({page},testInfo)=>{
 const failures=errors(page);await prepare(page);await settings(page);
 await expect(page.getByRole('button',{name:'Import theme',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Create theme',exact:true})).toHaveCount(0);
 await expect(page.locator('[data-theme-option-id]')).toHaveCount(6);
 await expect(page.locator('.ling-ui-theme-option-scene')).toHaveCount(4);
 await sceneScreenshot(page,testInfo,'official-scene-theme-picker.png');

 await page.locator('[data-theme-option-id="ling-breeze"]').click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-ui-theme','ling-breeze');
 await expect(page.locator('html')).toHaveAttribute('data-background-source','theme-scene');
 await expect(page.locator('[data-background-layer] svg[data-scene="forest-breeze"]')).toBeVisible();
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--ling-action-accent').trim())).toBe('#315c43');
 await sceneScreenshot(page,testInfo,'ling-breeze-home.png');

 await settings(page);await page.locator('[data-theme-option-id="ling-ocean"]').click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await expect(page.locator('[data-background-layer] svg[data-scene="ocean-drift"]')).toBeVisible();
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--ling-action-accent').trim())).toBe('#235e7c');
 await sceneScreenshot(page,testInfo,'ling-ocean-home.png');

 await settings(page);await page.locator('[data-theme-option-id="ling-night"]').click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-color-scheme','dark');
 await expect(page.locator('[data-background-layer] svg[data-scene="midnight-aurora"]')).toBeVisible();
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--ling-action-accent').trim())).toBe('#dfb77b');
 await sceneScreenshot(page,testInfo,'ling-night-home.png');

 await settings(page);await page.locator('[data-theme-option-id="ling-journey"]').click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-ui-theme','ling-journey');
 await expect(page.locator('html')).toHaveAttribute('data-color-scheme','dark');
 await expect(page.locator('[data-background-layer] svg[data-scene="farbound-journey"] image')).toHaveAttribute('href','/themes/ling-journey/ling-journey-v4-depth-dark.webp');
 await expect(page.locator('[data-background-layer] video')).toHaveCount(0);
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--ling-action-accent').trim())).toBe('#c49a63');
 await sceneScreenshot(page,testInfo,'ling-journey-home.png');

 await settings(page);await select(page);await apply(page);await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-background-source','local-image');
 await expect(page.locator('[data-background-layer] img')).toBeVisible();
 await settings(page);await expect(page.locator('[data-background-layer]')).toBeHidden();
 await page.getByRole('button',{name:'Restore default background'}).click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-background-source','theme-scene');
 await expect(page.locator('[data-background-layer] svg[data-scene="farbound-journey"] image')).toBeVisible();
 expect(failures).toEqual([]);
});

test('BG-06 journey scene uses the static depth artwork without a runtime video',async({page},testInfo)=>{
 const failures=errors(page);await prepare(page);await settings(page);
 await page.locator('[data-theme-option-id="ling-journey"]').click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 const scene=page.locator('[data-background-layer] svg[data-scene="farbound-journey"]');await expect(scene).toBeVisible();
 await expect(scene.locator('image')).toHaveAttribute('href','/themes/ling-journey/ling-journey-v4-depth-dark.webp');
 await expect(page.locator('[data-background-layer] video')).toHaveCount(0);
 await expect(page.locator('[data-background-layer] .ling-journey-rider')).toHaveCount(0);
 await sceneScreenshot(page,testInfo,'ling-journey-static.png');
 expect(failures).toEqual([]);
});

test('BG-06 built-in journey theme keeps its dark first paint after reload',async({page})=>{
 const failures=errors(page);await prepare(page);await settings(page);
 await page.locator('[data-theme-option-id="ling-journey"]').click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await page.reload();
 await expect(page.locator('html')).toHaveAttribute('data-ui-theme','ling-journey');
 await expect(page.locator('html')).toHaveAttribute('data-theme-first-paint','ling-journey');
 await expect(page.locator('html')).toHaveAttribute('data-color-scheme','dark');
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--ling-bg-app').trim())).toBe('#0d141c');
 await expect(page.locator('[data-background-layer] svg[data-scene="farbound-journey"] image')).toHaveAttribute('href','/themes/ling-journey/ling-journey-v4-depth-dark.webp');
 await expect(page.locator('[data-background-layer] video')).toHaveCount(0);
 expect(failures).toEqual([]);
});

test('BG-11/12/13/14 local MP4 and WebM dynamic wallpapers play, pause and restore the theme scene',async({page},testInfo)=>{
 const failures=errors(page);await prepare(page);await settings(page);
 await page.locator('[data-theme-option-id="ling-breeze"]').click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-background-source','theme-scene');
 await settings(page);

 for (const media of [
  {name:'dynamic-wallpaper.mp4',mimeType:'video/mp4',buffer:mp4},
  {name:'dynamic-wallpaper.webm',mimeType:'video/webm',buffer:webm},
 ] as const) {
  await page.locator('[data-background-file]').setInputFiles(media);
  await expect(page.locator('[data-background-preview]')).toHaveAttribute('data-draft','true');
  await expect(page.locator('.background-preview video')).toBeVisible();
  await apply(page);await page.getByRole('button',{name:'Back to app',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-background-source','local-video');
  const video=page.locator('[data-background-layer] video');
  await expect(video).toBeVisible();
  await expect.poll(()=>video.evaluate(element=>({paused:element.paused,muted:element.muted,loop:element.loop,time:element.currentTime}))).toMatchObject({paused:false,muted:true,loop:true});
  await sceneScreenshot(page,testInfo,`${media.name}-wallpaper.png`);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect.poll(()=>video.evaluate(element=>element.paused)).toBe(true);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await settings(page);await page.getByRole('button',{name:'Restore default background'}).click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-background-source','theme-scene');
  await expect(page.locator('[data-background-layer] svg[data-scene="forest-breeze"]')).toBeVisible();
  await settings(page);
 }
 expect(failures).toEqual([]);
});

test('BG-01/02/17/18/21 validation, keyboard, synthetic drop and 20 resource cycles',async({page},testInfo)=>{
 const failures=errors(page);await prepare(page);const section=await settings(page);
 const session=await page.context().newCDPSession(page);await session.send('HeapProfiler.collectGarbage');const baseline=await session.send('Runtime.getHeapUsage');
 await page.locator('[data-background-file]').setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});await expect(section.getByRole('alert')).toBeVisible();
 for(let i=0;i<20;i++) {
  await select(page);
  if(i%2) {await apply(page);await page.getByRole('button',{name:'Restore default background'}).click();await expect(page.locator('html')).toHaveAttribute('data-user-background','off');}
  else {await page.getByRole('button',{name:'Cancel preview'}).focus();await page.keyboard.press('Enter');}
 }
 await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'__backgroundUrls'))).toBe(0);
 await session.send('HeapProfiler.collectGarbage');const end=await session.send('Runtime.getHeapUsage');const retainedHeapBytes=end.usedSize-baseline.usedSize;expect(retainedHeapBytes).toBeLessThan(16*1024*1024);await writeFile(testInfo.outputPath('resource-cycles.json'),JSON.stringify({cycles:20,retainedHeapBytes,budgetBytes:16*1024*1024,objectUrls:0,scope:'renderer JS heap after GC; excludes decoded/GPU/native RSS'},null,2));
 const transfer=await page.evaluateHandle(bytes=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'dropped.png',{type:'image/png'}));return data},[...png]);
 await section.locator('.background-editor').dispatchEvent('dragover',{dataTransfer:transfer});
 await section.locator('.background-editor').dispatchEvent('drop',{dataTransfer:transfer});await transfer.dispose();
 await expect(page.locator('[data-background-preview]')).toHaveAttribute('data-draft','true');
 await page.getByRole('button',{name:'Apply background'}).focus();await page.keyboard.press('Enter');await expect(page.locator('html')).toHaveAttribute('data-user-background','ready');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(failures).toEqual([]);
});

test('BG-10/11/12/15/24 real IndexedDB transactions, lost receipt, stale writers and corruption',async({page})=>{
 await prepare(page);
 const result=await page.evaluate(async bytes=>{
  const path='/src/shared/ui/background/web-background-repository.ts';const {WebBackgroundRepository}=await import(path);
  const themePath='/src/shared/ui/theme/web-theme-database.ts';const {openWebThemeDatabase}=await import(themePath);
  // Use Vite's ordinary workspace dependency URL, with a native digest to keep the fixture independent of module resolution.
  const digest=async(input:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(input)))),b=>b.toString(16).padStart(2,'0')).join('');
  const request=async(revision:number,selection:{kind:string;assetId?:string},id:string)=>({requestId:id,expectedRevision:revision,selection,opacity:.6,payloadDigest:await digest([revision,selection.kind,selection.assetId??null,.6])});
  const a=new WebBackgroundRepository(),b=new WebBackgroundRepository();const prepared=await a.prepare({requestId:'prepare',bytes:new Uint8Array(bytes),fileName:'a.png',mimeType:'image/png'});
  const write=await request(0,{kind:'local-image',assetId:prepared.asset.assetId},'write');const first=await a.commit(write);const receipt=await b.commit(write);
  const race=await Promise.allSettled([a.commit(await request(1,{kind:'none'},'clear')),b.commit(await request(1,{kind:'none'},'stale'))]);
  let oldCode='';try{await a.commit(write)}catch(e){oldCode=(e as {code:string}).code}
  const cleared=await b.read();
  const again=await a.commit(await request(2,{kind:'local-image',assetId:prepared.asset.assetId},'again'));
  const db=await openWebThemeDatabase();const tx=db.transaction('background-assets','readwrite');tx.objectStore('background-assets').delete(prepared.asset.assetId);await new Promise<void>((res,rej)=>{tx.oncomplete=()=>res();tx.onabort=()=>rej(tx.error)});db.close();
  const corrupt=await b.read();return {first,receipt,race:race.map(x=>x.status),oldCode,cleared,again,corrupt};
 },[...png]);
 expect(result.first.revision).toBe(1);expect(result.receipt.revision).toBe(1);expect(result.race.filter(x=>x==='fulfilled')).toHaveLength(1);expect(result.oldCode).toBe('conflict');expect(result.cleared.preference.selection.kind).toBe('none');expect(result.again.revision).toBe(3);expect(result.corrupt.resourceError).toBe('corrupt');expect(result.corrupt.preference.revision).toBe(3);
 await page.reload();await settings(page);await expect(page.locator('[data-background-settings]').getByRole('alert')).toContainText('could not be loaded');await page.getByRole('button',{name:'Restore default background'}).click();await expect(page.locator('html')).toHaveAttribute('data-user-background','off');
});

test('BG-24 v3 migration retains themes/drafts; blocked upgrade recovers; compatible opener preserves stores',async({page})=>{
 await page.route('**/background-storage-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Storage fixture</title>'}));
 await page.goto('/background-storage-fixture');
 const result=await page.evaluate(async()=>{
  const old=await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open('ling-stack-ui2',3);req.onupgradeneeded=()=>{for(const store of ['themes','theme-packages','theme-assets','theme-drafts','theme-draft-assets'])req.result.createObjectStore(store,{keyPath:store==='themes'||store==='theme-drafts'?'id':'key'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
  const tx=old.transaction(['themes','theme-drafts'],'readwrite');tx.objectStore('themes').put({id:'preserved-theme',sentinel:1});tx.objectStore('theme-drafts').put({id:'preserved-draft',sentinel:2});await new Promise<void>(res=>tx.oncomplete=()=>res());
  const path='/src/shared/ui/theme/web-theme-database.ts';const {openWebThemeDatabase}=await import(path);let blocked=false;
  try{await openWebThemeDatabase()}catch{blocked=true}old.close();
  const db=await openWebThemeDatabase();const read=(store:string,key:string)=>new Promise(resolve=>{const req=db.transaction(store).objectStore(store).get(key);req.onsuccess=()=>resolve(req.result)});
  const theme=await read('themes','preserved-theme'),draft=await read('theme-drafts','preserved-draft');const version=db.version,stores=[...db.objectStoreNames];db.close();
  // Compatibility rollback retains this forward-compatible opener and only consumes the old stores.
  const compatible=await openWebThemeDatabase();const preserved=compatible.objectStoreNames.contains('background-assets');compatible.close();
  return {blocked,theme,draft,version,stores,preserved};
 });
 expect(result.blocked).toBe(true);expect(result.theme).toEqual({id:'preserved-theme',sentinel:1});expect(result.draft).toEqual({id:'preserved-draft',sentinel:2});expect(result.version).toBe(4);expect(result.preserved).toBe(true);
});

test('BG-10/11/17 cross-tab changes invalidate drafts; settings departure cancels candidates',async({page,context})=>{
 const failures=errors(page);await prepare(page);await settings(page);await select(page);
 const other=await context.newPage();await prepare(other);await settings(other);await select(other);await apply(other);
 await expect(page.locator('[data-background-settings]').getByRole('alert')).toContainText('changed elsewhere');await expect(page.getByRole('button',{name:'Apply background'})).toBeDisabled();
 await page.getByRole('button',{name:'Cancel preview'}).click();
 await select(page);await page.getByRole('button',{name:'Back to app'}).click();
 await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'__backgroundUrls'))).toBe(1);
 await settings(page);await page.getByRole('button',{name:'Restore default background'}).click();
 await expect(other.locator('html')).toHaveAttribute('data-user-background','off');expect(failures).toEqual([]);
});

test('BG-12 saving failure keeps committed image and permits recovery',async({page})=>{
 await prepare(page);await settings(page);await select(page);await apply(page);
 const previous=await page.locator('[data-background-layer] img').getAttribute('src');
 await select(page);
 await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;Reflect.set(window,'__originalBackgroundPut',original);IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore['put']>){if(this.name==='background-settings')throw new DOMException('Controlled quota fixture','QuotaExceededError');return original.apply(this,args)}});
 await page.getByRole('button',{name:'Apply background'}).click();await expect(page.locator('[data-background-settings]').getByRole('alert')).toBeVisible();
 await expect(page.locator('[data-background-layer] img')).toHaveAttribute('src',previous!);
 await page.evaluate(()=>{IDBObjectStore.prototype.put=Reflect.get(window,'__originalBackgroundPut')});
 await select(page);await apply(page);await page.getByRole('button',{name:'Restore default background'}).click();await expect(page.locator('html')).toHaveAttribute('data-user-background','off');
});

test('BG-05/06/22 real 4K photo normalizes, opens home and keeps reading hierarchy clear',async({page},testInfo)=>{
 test.setTimeout(60000);
 await prepare(page);await settings(page);
 await page.locator('[data-theme-option-id="ling-dark"]').click();await expect(page.locator('html')).toHaveAttribute('data-ui-theme','ling-dark');
 const buffer=photo;
 const measurements=await page.evaluate(async bytes=>{const path='/src/shared/ui/background/web-background-repository.ts';const {WebBackgroundRepository}=await import(path);const repo=new WebBackgroundRepository();const start=performance.now();const image=await repo.prepare({requestId:'perf',bytes:Uint8Array.from(atob(bytes),c=>c.charCodeAt(0)),fileName:'4k.jpg',mimeType:'image/jpeg'});const decodeMs=performance.now()-start;await repo.release('perf');return {decodeMs,width:image.asset.width,height:image.asset.height,bytes:image.bytes.length,dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],userAgent:navigator.userAgent}},buffer.toString('base64'));
 expect(measurements.decodeMs).toBeLessThan(2000);expect(measurements.width).toBe(2560);expect(measurements.height).toBe(1150);expect(measurements.bytes).toBeLessThan(16*1024*1024);
 await select(page,buffer,true);await expect(page.getByText('Prepared at 2560 × 1150 pixels. Your source file is unchanged.')).toBeVisible();const start=performance.now();await apply(page);const commitMs=performance.now()-start;expect(commitMs).toBeLessThan(2000);
 await page.screenshot({path:testInfo.outputPath('background-settings.png')});
 await page.getByRole('button',{name:'Back to app'}).click();
 for(const [label,value,scrim] of [['soft',45,.55],['balanced',60,.4],['vivid',75,.25]] as const) {
  await settings(page);
  await setOpacity(page,value);await apply(page);
  await page.getByRole('button',{name:'Back to app'}).click();
  await expect(page.locator('.workspace-background-scrim')).toHaveCSS('opacity',String(scrim));
  expect(await page.locator('.workspace').evaluate(element=>getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('.conversation-home-identity')).toHaveCount(0);
  await expect(page.locator('.conversation-home h1')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await page.screenshot({path:testInfo.outputPath(`background-photo-dark-${label}.png`)});
 }
 await settings(page);await page.locator('[data-theme-option-id="ling-light"]').click();await page.getByRole('button',{name:'Back to app'}).click();await page.screenshot({path:testInfo.outputPath('background-photo-light.png')});
 await page.getByRole('button',{name:'Open recent conversation 1',exact:true}).click();
 const feedFrameColor=await page.locator('.normal-conversation-feed-frame').first().evaluate(element=>getComputedStyle(element).backgroundColor);
 expect(feedFrameColor).toBe('rgba(0, 0, 0, 0)');
 const composerColor=await page.locator('[data-conversation-composer]').first().evaluate(element=>getComputedStyle(element).backgroundColor);
 expect(composerColor).not.toContain('rgba');expect(composerColor).not.toBe('transparent');
 const performanceEvidence={...measurements,commitMs,fixtureSha256:createHash('sha256').update(buffer).digest('hex'),host:{platform:process.platform,arch:process.arch},budgets:{decodeMs:2000,commitMs:2000},scope:'Chromium renderer on local host; real CC BY-SA 3.0 Fronalpstock photo; not native package evidence'};
 await testInfo.attach('performance.json',{body:JSON.stringify(performanceEvidence,null,2),contentType:'application/json'});
 await writeFile(testInfo.outputPath('performance.json'),JSON.stringify(performanceEvidence,null,2));
});

for(const state of ['ready','blocked','pending','error','pi'] as const) test(`BG-20 native ${state}: background changes preserve draft, focus and send authority`,async({page},testInfo)=>{
 const runs:string[]=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/runs' && request.method()==='POST')runs.push(request.postData()??'')});
 await prepare(page,state);
 await page.getByRole('button',{name:/Open recent conversation \d+/}).filter({hasText:normalConversationFixtureTitle}).click();
 await expect(page.locator('.normal-conversation-page')).toBeVisible();
 if(state==='pi') await page.getByRole('button',{name:'Show details',exact:true}).click();
 const composer=page.getByLabel('New conversation composer',{exact:true});const textarea=composer.getByRole('textbox');
 await textarea.fill('Keep this draft while changing the background');await textarea.focus();
 const sendButton=composer.getByRole('button',{name:'Send',exact:true});
 if(state==='ready'||state==='pi') await expect(sendButton).toBeEnabled();
 else await expect(sendButton).toBeDisabled();
 const before=await sendButton.isEnabled();
 await textarea.evaluate(element=>element.setAttribute('data-background-retained','true'));
 await page.evaluate(async bytes=>{
  const path='/src/shared/ui/background/web-background-repository.ts';const {WebBackgroundRepository}=await import(path);const repository=new WebBackgroundRepository();const {preference}=await repository.read();const image=await repository.prepare({requestId:'background-test',bytes:new Uint8Array(bytes),fileName:'a.png',mimeType:'image/png'});
  const digest=async(input:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(input)))),b=>b.toString(16).padStart(2,'0')).join('');
  const selection={kind:'local-image',assetId:image.asset.assetId};await repository.commit({requestId:'change',expectedRevision:preference.revision,selection,opacity:.6,payloadDigest:await digest([preference.revision,'local-image',image.asset.assetId,.6])});await repository.release('background-test');const channel=new BroadcastChannel('ling-background-revision');channel.postMessage(null);channel.close();
 },[...png]);
 await expect(page.locator('html')).toHaveAttribute('data-user-background','ready');
 await expect(textarea).toHaveText('Keep this draft while changing the background');await expect(textarea).toBeFocused();await expect(textarea).toHaveAttribute('data-background-retained','true');expect(await composer.getByRole('button',{name:'Send',exact:true}).isEnabled()).toBe(before);expect(runs).toEqual([]);
 if(state==='pi') {
  await expect(page.locator('.right-dock')).toBeVisible();await expect(page.locator('.right-dock')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  const readingSurface=page.locator('.normal-conversation-feed-frame');await expect(readingSurface).toBeVisible();expect(await readingSurface.evaluate(element=>getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({path:testInfo.outputPath('background-conversation-dock.png')});
 }
});

test('BG-23 incomplete Desktop capability stays solid and never writes background Web stores',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(window,'lingDesktop',{value:{platform:'macos',daemonBaseUrl:'http://127.0.0.1:17891',appearance:{reportTheme:()=>{}},computerUse:{reportLocale:()=>{},reportSelectedDeckOwner:()=>{},reportSelectedConversation:()=>{},reportHostLayout:()=>{},getPreferences:async()=>({previewAutoShow:true}),setAutoShow:async()=>({accepted:true}),onSummaryChanged:()=>()=>{}} },configurable:true}));
 await prepare(page);
 await page.getByRole('complementary',{name:/Sidebar display|侧栏显示/u}).getByRole('button',{name:'Settings'}).click();await page.getByLabel('Settings sections').getByRole('button',{name:'Interface preferences',exact:true}).click();
 await expect(page.locator('[data-background-settings]').getByRole('button',{name:'Choose or replace media'})).toBeDisabled();await expect(page.locator('[data-background-settings]').getByRole('alert')).toBeVisible();
 const count=await page.evaluate(async()=>{const path='/src/shared/ui/theme/web-theme-database.ts';const {openWebThemeDatabase}=await import(path);const db=await openWebThemeDatabase();const tx=db.transaction('background-settings');const count=await new Promise<number>(resolve=>{const req=tx.objectStore('background-settings').count();req.onsuccess=()=>resolve(req.result)});db.close();return count});expect(count).toBe(0);await expect(page.locator('html')).toHaveAttribute('data-user-background','off');
});

test('BG-10/17 delayed decode discards old generations; committed work survives leaving settings',async({page})=>{
 await prepare(page);await settings(page);
 await page.evaluate(()=>{const original=window.createImageBitmap.bind(window);let first=true;window.createImageBitmap=(...args:any[])=>{if(!first)return (original as any)(...args);first=false;return new Promise(resolve=>Reflect.set(window,'__releaseBackgroundDecode',async()=>resolve(await (original as any)(...args))))}});
 await page.locator('[data-background-file]').setInputFiles({name:'first.png',mimeType:'image/png',buffer:png});
 await expect.poll(()=>page.evaluate(()=>typeof Reflect.get(window,'__releaseBackgroundDecode'))).toBe('function');
 await page.locator('[data-background-file]').setInputFiles({name:'second.png',mimeType:'image/png',buffer:png});
 await page.evaluate(()=>Reflect.get(window,'__releaseBackgroundDecode')());await expect(page.locator('[data-background-preview]')).toHaveAttribute('data-draft','true');
 await page.evaluate(async()=>{const path='/src/shared/ui/background/web-background-repository.ts';const {WebBackgroundRepository}=await import(path);const original=WebBackgroundRepository.prototype.commit;WebBackgroundRepository.prototype.commit=async function(input:unknown){const result=await original.call(this,input);return new Promise(resolve=>Reflect.set(window,'__releaseBackgroundCommit',()=>resolve(result)))}});
 await page.getByRole('button',{name:'Apply background'}).click();await expect.poll(()=>page.evaluate(()=>typeof Reflect.get(window,'__releaseBackgroundCommit'))).toBe('function');
 await page.getByRole('button',{name:'Back to app'}).click();await page.evaluate(()=>Reflect.get(window,'__releaseBackgroundCommit')());await expect(page.locator('html')).toHaveAttribute('data-user-background','ready');
 await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'__backgroundUrls'))).toBe(1);
});

// Explicit local visual evidence run; intentional holds let viewers see the real 180 ms edge glint.
test.describe('recorded photo and motion demonstration',()=>{
 test.skip(process.env.LING_BACKGROUND_DEMO!=='1','Opt-in recording, not a timing regression test');
 test('actual production effects with a real photograph and theme colors',async({page},testInfo)=>{
  test.setTimeout(60000);const failures=errors(page);await prepare(page);const panel=await settings(page);
  const markers:{name:string;elapsedMs:number}[]=[];const start=Date.now();
  const mark=(name:string)=>markers.push({name,elapsedMs:Date.now()-start});
  const pause=(ms:number)=>page.waitForTimeout(ms);
  await expect(page.getByRole('button',{name:'Import theme',exact:true})).toHaveCount(0);
  await expect(page.locator('[data-theme-option-id="ling-breeze"] .ling-ui-theme-option-scene')).toBeVisible();
  await page.locator('[data-theme-option-id="ling-dark"]').click();
  const sweep=async(id:string)=>{const card=page.locator(`[data-theme-option-id="${id}"]`);await card.scrollIntoViewIfNeeded();const box=(await card.boundingBox())!;for(let i=0;i<=40;i++){await page.mouse.move(box.x+20+(box.width-40)*i/40,box.y+35+Math.sin(i/40*Math.PI)*35);await pause(25)}};
  mark('dark-card-spotlight');await sweep('ling-dark');await pause(750);
  await page.locator('[data-theme-option-id="ling-breeze"]').click();mark('green-card-spotlight');await sweep('ling-light');await pause(1000);
  const zone=panel.locator('.background-editor');await zone.scrollIntoViewIfNeeded();
  const transfer=await page.evaluateHandle(data=>{const value=new DataTransfer();value.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'fronalpstock.jpg',{type:'image/jpeg'}));return value},photo.toString('base64'));
  const box=(await zone.boundingBox())!;const coordinates={clientX:box.x+box.width*.56,clientY:box.y+box.height*.55};
  mark('green-drag-highlight');await zone.dispatchEvent('dragover',{dataTransfer:transfer,...coordinates});await expect(zone.locator('[data-active="true"]')).toBeVisible();await pause(1400);
  // Observe real animation lifecycle and theme color without changing its speed/style.
  await zone.evaluate(element=>{new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node instanceof Element&&node.matches('.ling-ui-file-drop-glint'))Reflect.set(window,'__photoDemoGlint',{duration:getComputedStyle(node).animationDuration,background:getComputedStyle(node).backgroundImage,shadow:getComputedStyle(node).boxShadow,edge:node.getAttribute('data-edge')})}).observe(element,{childList:true,subtree:true})});
  mark('green-drop-edge-glint');await zone.dispatchEvent('drop',{dataTransfer:transfer,...coordinates});await transfer.dispose();
  await expect(page.locator('[data-background-preview]')).toHaveAttribute('data-draft','true');await pause(1500);
  const glint=await page.evaluate(()=>Reflect.get(window,'__photoDemoGlint'));expect(glint.duration).toBe('0.18s');
  await apply(page);await page.getByRole('button',{name:'Back to app',exact:true}).click();mark('green-photo-home');await pause(1600);
  await page.screenshot({path:testInfo.outputPath('green-photo-home.png')});
  await settings(page);await page.locator('[data-theme-option-id="ling-dark"]').click();await page.getByRole('button',{name:'Back to app',exact:true}).click();mark('dark-photo-home');await pause(1600);
  await page.getByRole('button',{name:'Open recent conversation 1',exact:true}).click();mark('opaque-conversation');await pause(1600);
  await page.screenshot({path:testInfo.outputPath('opaque-conversation.png')});expect(failures).toEqual([]);
  await writeFile(testInfo.outputPath('motion-markers.json'),JSON.stringify({markers,glint,scope:'Playwright regression browser, production CSS timings, real photograph, synthetic file drag events; no style overrides',photo:'Hannes Röst / Fronalpstock / CC BY-SA 3.0; see fixtures/README.md'},null,2));
 });
});
