import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBackgroundRepository } from '../dist/main/backgrounds/background-repository.js';
import { sanitizeBackground } from '../dist/main/backgrounds/background-codec.js';
const root=new URL('../../../packages/daemon/',import.meta.url);
const helper=fileURLToPath(new URL('dist/native/image-sanitizer/'+(process.platform==='win32'?'ling-image-sanitizer.exe':'ling-image-sanitizer'),root));
test('BG-01/02/23 actual product codec normalizes PNG JPEG WebP, EXIF 1..8 and color inputs',async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'ling-bg-codec-')));t.after(()=>rm(directory,{recursive:true,force:true}));
 const r=new DesktopBackgroundRepository(join(directory,'backgrounds'),helper);
 for(const name of ['source.png','source.jpg','source.webp','alpha.png','interlaced.png','progressive.jpg','color/p3.jpg','color/p3-alpha.png',...Array.from({length:8},(_,i)=>`golden/jpeg/${i+1}.jpg`)]) {
  const bytes=new Uint8Array(await readFile(new URL('native/image-sanitizer/fixtures/'+name,root)));
  const image=await r.prepare({requestId:'p',bytes,fileName:name.split('/').at(-1),mimeType:name.endsWith('.jpg')?'image/jpeg':name.endsWith('.webp')?'image/webp':'image/png'});
  assert.equal(image.asset.mimeType,'image/png');assert.ok(image.asset.width>0);await r.release('p');
 }
});
test('BG-23 runtime codec nonzero, truncated output, timeout and cancellation leave no candidate',async t=>{
 if(process.platform==='win32'){t.skip('POSIX fake executables; real Windows gate is separate');return;}
 const dir=await realpath(await mkdtemp(join(tmpdir(),'ling-bg-bad-codec-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const png=new Uint8Array(await readFile(new URL('native/image-sanitizer/fixtures/source.png',root)));
 for(const [name,code] of [['exit','process.exit(2)'],['truncated','process.stdout.write("truncated")'],['timeout','process.stdin.resume();setTimeout(()=>{},30000)']]) {
  const path=join(dir,name);await writeFile(path,`#!${process.execPath}\n${code}\n`);await chmod(path,0o755);
  const r=new DesktopBackgroundRepository(join(dir,'backgrounds'),path);
  await assert.rejects(()=>r.prepare({requestId:'p',bytes:png,fileName:'a.png',mimeType:'image/png'}));
 }
 const path=join(dir,'timeout'),controller=new AbortController();const pending=sanitizeBackground(png,path,controller.signal);controller.abort();await assert.rejects(()=>pending,{code:'aborted'});
});

test('BG-01 real high-detail 4K photo uses bounded wallpaper normalization in the product codec',async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'ling-bg-photo-')));t.after(()=>rm(directory,{recursive:true,force:true}));
 const r=new DesktopBackgroundRepository(join(directory,'backgrounds'),helper);
 const bytes=new Uint8Array(await readFile(new URL('../../web/e2e/fixtures/fronalpstock-3840.jpg',import.meta.url)));
 const image=await r.prepare({requestId:'photo',bytes,fileName:'fronalpstock.jpg',mimeType:'image/jpeg'});
 assert.equal(image.asset.width,2560);assert.equal(image.asset.height,1150);assert.ok(image.bytes.length<16*1024*1024);
 await r.release('photo');
});
