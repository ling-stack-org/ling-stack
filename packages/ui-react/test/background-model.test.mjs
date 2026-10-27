import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_BACKGROUND, parseBackgroundPreference, parseBackgroundAsset, inspectBackgroundImage,
  resolveBackgroundPanelAlpha, resolveBackgroundSidebarAlpha, resolveBackgroundWorkspaceAlpha, PresentationProfileRegistry,
  backgroundOpacityFromStrength, backgroundPayloadDigest, backgroundVideoMimeType, verifyBackgroundCommit,
  backgroundOutputDimensions, backgroundThemeProfile, commitBackgroundPreference, backgroundSurfaceOpacity } from '../dist/theme/index.js';
const chunk=(type,bytes)=>Buffer.concat([Buffer.from([0,0,0,bytes.length]),Buffer.from(type),bytes,Buffer.alloc(4)]);
function png(w=10,h=10,extra=[]) { const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h,4); return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),...extra,chunk('IDAT',Buffer.from([1])),chunk('IEND',Buffer.alloc(0))]); }
function jpeg(w=10,h=10) {
 const sof=Buffer.from([0xff,0xc0,0,11,8,(h>>8)&0xff,h&0xff,(w>>8)&0xff,w&0xff,3,1,0x11,0]);
 const scan=Buffer.from([0xff,0xda,0,8,0,0,0,0,0,0,0,0xff,0xd9]);
 return Buffer.concat([Buffer.from([0xff,0xd8]),sof,scan]);
}
test('BG-01/02 strict state, IDs, bounded predecode and animated containers',()=>{
 assert.deepEqual(parseBackgroundPreference(INITIAL_BACKGROUND),INITIAL_BACKGROUND);
 assert.deepEqual(parseBackgroundPreference({schemaVersion:1,revision:7,selection:{kind:'none'},strength:'strong'}),{schemaVersion:3,revision:7,selection:{kind:'none'},opacity:.75,profiles:{}});
 for(const value of [{...INITIAL_BACKGROUND,url:'https://x'}, {...INITIAL_BACKGROUND,revision:-1}, {...INITIAL_BACKGROUND,selection:{kind:'local-image',assetId:'../x'}}]) assert.throws(()=>parseBackgroundPreference(value));
 assert.throws(()=>parseBackgroundAsset({assetId:'a'.repeat(64),mimeType:'image/png',byteLength:20,width:8193,height:1}));
 assert.equal(backgroundVideoMimeType(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109]),'a.mp4','video/mp4'),'video/mp4');
 assert.equal(backgroundVideoMimeType(Uint8Array.from([0x1a,0x45,0xdf,0xa3,1]),'a.webm','video/webm'),'video/webm');
 assert.deepEqual(inspectBackgroundImage(png(),'a.png','image/png'),{mimeType:'image/png',width:10,height:10});
 assert.deepEqual(inspectBackgroundImage(jpeg(),'wallpaper.png','image/png'),{mimeType:'image/jpeg',width:10,height:10});
 assert.deepEqual(inspectBackgroundImage(png(),'wallpaper.jpg','image/jpeg'),{mimeType:'image/png',width:10,height:10});
 for(const bytes of [png(8193,1),png(5000,4000),png(10,10,[chunk('acTL',Buffer.alloc(8))]),png().subarray(0,25),Buffer.from('GIF89a'),Buffer.from('<svg/>')]) assert.throws(()=>inspectBackgroundImage(bytes));
});
test('BG-05/06/07/08 opt-in surface policy and conservative material',()=>{
 const registry=new PresentationProfileRegistry();
 assert.equal(registry.resolveSurface('ling-standard','home',{userBackground:true,viewportWidth:1440}).surfaceRecipe,'translucent');
 for(const surface of ['settings','management','diagnostics','approvals','media-canvas']) assert.notEqual(registry.resolveSurface('ling-standard',surface,{userBackground:true}).surfaceRecipe,'translucent');
 assert.equal(registry.resolveSurface('ling-standard','management',{userBackground:true,ambientWorkspace:true,viewportWidth:1440}).surfaceRecipe,'translucent');
 for(const context of [{viewportWidth:1179},{forcedColors:true},{reducedTransparency:true}]) assert.notEqual(registry.resolveSurface('ling-standard','home',{userBackground:true,...context}).surfaceRecipe,'translucent');
 assert.equal(resolveBackgroundPanelAlpha({app:'rgb(0 0 0)',panel:'#000000',opacity:.75,foregrounds:[{color:'#ffffff',minimum:4.5}]}),1);
 assert.ok(resolveBackgroundPanelAlpha({app:'#ffffff',panel:'#ffffff',opacity:.75,foregrounds:[{color:'#767676',minimum:4.5}]})>=.8);
});
test('BG-11/13 canonical payload digest and exact request parser',async()=>{
 const input={expectedRevision:0,selection:{kind:'none'},opacity:.6};
 const req={...input,requestId:'test-1',payloadDigest:await backgroundPayloadDigest(input)};
 await verifyBackgroundCommit(req);
 await assert.rejects(()=>verifyBackgroundCommit({...req,opacity:.75}));
 await assert.rejects(()=>verifyBackgroundCommit({...req,path:'/tmp/x'}));
});

test('BG-06 every content-panel foreground meets its threshold over both image extremes',async()=>{
 const {ThemeRegistry,backgroundRecipe}=await import('../dist/theme/index.js');
 const {mixHex,contrastRatio}=await import('../dist/theme/compiler/color-utils.js');
 for(const {manifest:theme} of new ThemeRegistry().list()) for(const opacity of [.45,.6,.75]) for(const panel of [theme.tokens.background.panel]) {
  const foregrounds=[theme.tokens.text.default,theme.tokens.text.muted,theme.tokens.text.strong,theme.tokens.text.link].map(color=>({color,minimum:4.5}));foregrounds.push({color:theme.tokens.border.focus,minimum:3});
  const alpha=resolveBackgroundPanelAlpha({app:theme.tokens.background.app,panel,opacity,foregrounds});
  for(const image of ['#000000','#ffffff']) for(const foreground of foregrounds) {
   const composite=mixHex(mixHex(image,theme.tokens.background.app,backgroundRecipe(opacity).scrim),panel,alpha);
   // An opaque fallback preserves the theme's original validation contract.
   if(alpha<1) assert.ok(contrastRatio(foreground.color,composite)>=foreground.minimum,`${theme.id}/${opacity}/${foreground.color}`);
  }
 }
});

test('BG-06 sidebar structure keeps equal photo exposure while interaction states protect focus',async()=>{
 const {lingLightTheme,lingDarkTheme,backgroundRecipe}=await import('../dist/theme/index.js');
 const {mixHex,contrastRatio}=await import('../dist/theme/compiler/color-utils.js');
 for(const opacity of [.45,.6,.75]) {
  const recipe=backgroundRecipe(opacity);const exposures=[];
  for(const theme of [lingLightTheme,lingDarkTheme]) {
   const alpha=resolveBackgroundSidebarAlpha({app:theme.tokens.background.app,sidebar:theme.tokens.background.sidebar});
   assert.equal(alpha,.68);exposures.push((1-recipe.scrim)*(1-alpha));
   for(const image of ['#000000','#ffffff']) {
    const structure=mixHex(mixHex(image,theme.tokens.background.app,recipe.scrim),theme.tokens.background.sidebar,alpha);
    assert.ok(contrastRatio(theme.tokens.text.default,structure)>=4.5,`${theme.id}/${opacity}/sidebar text`);
   }
   const active=theme.tokens.action.selection;
   assert.ok(contrastRatio(theme.tokens.text.strong,active)>=4.5,`${theme.id}/${opacity}/active sidebar text`);
   assert.ok(contrastRatio(theme.tokens.border.focus,active)>=3,`${theme.id}/${opacity}/active sidebar focus`);
  }
  assert.equal(exposures[0],exposures[1],`${opacity} photo exposure must match across light and dark themes`);
  assert.ok(exposures[0]>=.12,`${opacity} sidebar must visibly expose the photograph`);
 }
 assert.equal(resolveBackgroundSidebarAlpha({app:'rgb(0 0 0)',sidebar:'#000000'}),1);
});

test('BG-06 open workspace exposes the photograph while strong display text stays readable',async()=>{
 const {lingLightTheme,lingDarkTheme,backgroundRecipe}=await import('../dist/theme/index.js');
 const {mixHex,contrastRatio}=await import('../dist/theme/compiler/color-utils.js');
 for(const theme of [lingLightTheme,lingDarkTheme]) {
  const alpha=resolveBackgroundWorkspaceAlpha({app:theme.tokens.background.app,panel:theme.tokens.background.panel,foreground:theme.tokens.text.strong,opacity:.6});
  const panelAlpha=resolveBackgroundPanelAlpha({app:theme.tokens.background.app,panel:theme.tokens.background.panel,opacity:.6,foregrounds:[{color:theme.tokens.text.strong,minimum:4.5}]});
  assert.ok(alpha<panelAlpha,`${theme.id} workspace must remain more transparent than a content panel`);
  for(const image of ['#000000','#ffffff']) {
   const composite=mixHex(mixHex(image,theme.tokens.background.app,backgroundRecipe(.6).scrim),theme.tokens.background.panel,alpha);
   assert.ok(contrastRatio(theme.tokens.text.strong,composite)>=4.5,`${theme.id}/balanced/workspace`);
  }
  const exposure=[.45,.6,.75].map(opacity=>(1-backgroundRecipe(opacity).scrim)*(1-alpha));
  assert.ok(exposure[0]<exposure[1]&&exposure[1]<exposure[2],`${theme.id} visibility strengths must remain distinct`);
 }
 assert.equal(resolveBackgroundWorkspaceAlpha({app:'rgb(0 0 0)',panel:'#000000',foreground:'#ffffff',opacity:.6}),1);
 assert.equal(backgroundOpacityFromStrength('balanced'),.6);
});

test('photo storage bounds both raw RGBA size and long edge without upscaling or changing aspect',()=>{
 for(const [input,expected] of [[[4096,2304],[2560,1440]],[[4000,4000],[2000,2000]],[[2304,4096],[1440,2560]],[[8192,1],[2560,1]],[[3,2],[3,2]]]) {
  assert.deepEqual(backgroundOutputDimensions(...input),{width:expected[0],height:expected[1]});
 }
 assert.throws(()=>backgroundOutputDimensions(5000,4000));
});

test('BG-H3 legacy migration and per-theme profiles preserve other themes and canonical receipts',async()=>{
 const old=parseBackgroundPreference({schemaVersion:2,revision:4,selection:{kind:'none'},opacity:.75});
 assert.equal(backgroundThemeProfile(old,'ling-journey').opacity,.75);
 const input={expectedRevision:4,selection:{kind:'none'},opacity:.4,presentation:{themeId:'ling-journey',focusX:85,focusY:20,paused:true}};
 const request={...input,requestId:'profile',payloadDigest:await backgroundPayloadDigest(input)};
 await verifyBackgroundCommit(request);
 for(const presentation of [{...input.presentation,focusX:84},{...input.presentation,paused:false},{...input.presentation,themeId:'ling-dark'}]) {
  await assert.rejects(()=>verifyBackgroundCommit({...request,presentation}));
 }
 const journey=commitBackgroundPreference(old,request);
 assert.deepEqual(backgroundThemeProfile(journey,'ling-journey'),{opacity:.4,focusX:85,focusY:20,paused:true});
 assert.equal(backgroundThemeProfile(journey,'ling-dark').opacity,.75,'a new theme inherits the legacy default, not another theme');
 const dark=commitBackgroundPreference(journey,{...request,expectedRevision:5,opacity:.9,presentation:{themeId:'ling-dark',focusX:10,focusY:90,paused:false}});
 assert.deepEqual(dark.profiles['ling-journey'],journey.profiles['ling-journey']);
 const legacy=commitBackgroundPreference(dark,{...request,presentation:undefined,expectedRevision:6,opacity:.6});
 assert.deepEqual(legacy.profiles,dark.profiles,'old clients cannot erase saved profiles');
 assert.equal(legacy.opacity,.6);
 for(const profile of [{opacity:NaN,focusX:50,focusY:50,paused:false},{opacity:.6,focusX:101,focusY:50,paused:false},{opacity:.6,focusX:0,focusY:-1,paused:false},{opacity:.6,focusX:0,focusY:0,paused:'false'}]) {
  assert.throws(()=>parseBackgroundPreference({...old,profiles:{'ling-dark':profile}}));
 }
 assert.equal(backgroundSurfaceOpacity(1,'home'),1);
 for(const surface of ['conversation','channel','management']) assert.equal(backgroundSurfaceOpacity(1,surface),.45);
});
