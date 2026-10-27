import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mockDaemon } from './support/mock-daemon';
import { createBaseState, createChatProvider } from './support/mock-state';
import { installNormalConversationFixture, normalConversationFixtureTitle } from './support/normal-conversation-fixture';
import { installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from './support/conversation-work-cell-fixture';
import { openEngineeringChannel } from './support/test-helpers';
import { expandTimelineProcesses } from './support/timeline-process';
const mp4 = await readFile(new URL('./fixtures/dynamic-wallpaper.mp4', import.meta.url));
async function prepare(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('ling-stack.locale','en-US');
    localStorage.setItem('ling-stack.themeSelection', JSON.stringify({mode:'fixed',themeId:'ling-journey'}));
  });
  const state=createBaseState({approvalStatus:'expired'});
  state.providers=[createChatProvider({id:'theme-test',lastCheck:{ok:true,code:'ready',message:'Isolated fixture',checkedAt:'2026-10-27T00:00:00Z'}})];
  state.workspaceSettings.defaultProviderPresetId=state.providers[0].id; state.approvals=[]; installNormalConversationFixture(state);
  await mockDaemon(page,state);
  await page.route('**/runtime/conversation-execution**',route=>route.fulfill({json:{status:'not_selected',defaultRunnerId:'pi'}}));
  await page.goto('/');
}
async function settings(page: Page) {
  await page.getByRole('complementary',{name:/Sidebar display|侧栏显示/u}).getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByLabel('Settings sections').getByRole('button',{name:'Interface preferences',exact:true}).click();
  await expect(page.locator('[data-background-opacity]')).toBeEnabled();
}
async function back(page: Page) { await page.getByRole('button',{name:'Back to app',exact:true}).click(); }
async function apply(page: Page) {
  await page.getByRole('button',{name:'Apply background',exact:true}).click();
  await expect(page.getByRole('button',{name:'Apply background',exact:true})).toHaveCount(0);
}
async function upload(page: Page) {
  await settings(page);
  await page.locator('[data-background-file]').setInputFiles({name:'wallpaper.mp4',mimeType:'video/mp4',buffer:mp4});
  await expect(page.locator('[data-background-preview]')).toHaveAttribute('data-draft','true');
  await apply(page);
}
const paused=(page:Page, selector:string)=>page.locator(selector).evaluate((v:HTMLVideoElement)=>v.paused);

test('BG-H1/H2 one visible player, reading surfaces, reduced motion, recovery and bounded fallback',async({page},info)=>{
  const failures:string[]=[]; page.on('pageerror',e=>failures.push(e.message));
  await prepare(page); await upload(page);
  await page.locator('[data-background-preview]').scrollIntoViewIfNeeded();
  await expect.poll(()=>paused(page,'[data-background-layer] video')).toBe(true);
  await expect.poll(()=>paused(page,'.background-preview video')).toBe(false);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect.poll(()=>paused(page,'.background-preview video')).toBe(true);
  await page.locator('[data-background-settings]').getByRole('button',{name:'Resume · Background',exact:true}).click();
  await expect.poll(()=>paused(page,'.background-preview video')).toBe(false);
  await back(page);
  await expect.poll(()=>paused(page,'[data-background-layer] video')).toBe(false);
  await page.getByRole('button',{name:'Pause · Background',exact:true}).click();
  await expect.poll(()=>paused(page,'[data-background-layer] video')).toBe(true);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.getByRole('button',{name:'Resume · Background',exact:true}).click();
  await expect.poll(()=>paused(page,'[data-background-layer] video')).toBe(false);
  await page.setViewportSize({width:1100,height:960});
  await expect.poll(()=>paused(page,'[data-background-layer] video')).toBe(true);
  await page.setViewportSize({width:1440,height:960});
  await expect.poll(()=>paused(page,'[data-background-layer] video')).toBe(false);
  await page.getByRole('button',{name:'Plugin Manager',exact:true}).click();
  const row=page.locator('.plugin-table-row').first(); await expect(row).toBeVisible();
  expect(await row.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await page.locator('html').evaluate(e=>getComputedStyle(e).getPropertyValue('--user-background-scrim'))).toBe('0.55');
  await page.screenshot({path:info.outputPath('plugins-reading-protection.png')});
  await page.getByRole('button',{name:/Open recent conversation \d+/u}).filter({hasText:normalConversationFixtureTitle}).click();
  const body=page.locator('[data-conversation-message-row].message-bubble-document.message-bubble-peer > .message-content').first();
  await expect(body).toBeVisible();
  expect(await body.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await body.evaluate(e=>e.getBoundingClientRect().width)).toBeLessThan(600);
  expect(await page.locator('.normal-conversation-feed-frame').evaluate(e=>getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({path:info.outputPath('conversation-reading-protection.png')});
  await expect(page.locator('[data-background-layer] video')).toHaveAttribute('poster',/^data:image\/jpeg/u);
  // Controlled decoder event verifies the product fallback and explicit retry path.
  await page.locator('[data-background-layer] video').dispatchEvent('error');
  await expect(page.locator('[data-background-video-fallback="poster"]')).toBeVisible();
  await page.getByRole('button',{name:'Retry loading',exact:true}).click();
  await expect.poll(()=>paused(page,'[data-background-layer] video')).toBe(false);
  expect(failures).toEqual([]);
});

test('BG-H3 focus and visibility are per-theme, cancel/recommend are drafts and refresh preserves media',async({page})=>{
  await prepare(page); await upload(page);
  await page.locator('[data-background-opacity]').fill('80');
  await page.locator('[data-background-focus="x"]').fill('88');
  await apply(page);
  await page.locator('[data-theme-option-id="ling-dark"]').click();
  await expect(page.locator('[data-background-opacity]')).toHaveValue('60');
  await expect(page.locator('[data-background-focus="x"]')).toHaveValue('50');
  await page.locator('[data-background-opacity]').fill('35');
  await page.locator('[data-background-focus="x"]').fill('20');
  await apply(page);
  await page.locator('[data-theme-option-id="ling-journey"]').click();
  await expect(page.locator('[data-background-opacity]')).toHaveValue('80');
  await expect(page.locator('[data-background-focus="x"]')).toHaveValue('88');
  await page.getByRole('button',{name:'Use recommended settings',exact:true}).click();
  await expect(page.locator('[data-background-opacity]')).toHaveValue('60');
  await page.getByRole('button',{name:'Cancel preview',exact:true}).click();
  await expect(page.locator('[data-background-opacity]')).toHaveValue('80');
  await back(page); await page.reload();
  await expect(page.locator('[data-background-layer] video')).toBeVisible();
  expect(await page.locator('[data-background-layer] video').evaluate(e=>getComputedStyle(e).objectPosition)).toBe('88% 50%');
  await settings(page);
  await expect(page.locator('[data-background-opacity]')).toHaveValue('80');
  await expect(page.locator('[data-background-focus="x"]')).toHaveValue('88');
});

test('BG-H2 a stalled decoder reloads once then keeps a still frame until explicit retry', async ({ page }) => {
  await page.clock.install();
  await prepare(page); await upload(page); await back(page);
  const player = page.locator('[data-background-layer] video');
  await expect.poll(() => paused(page, '[data-background-layer] video')).toBe(false);
  await expect(player).toHaveAttribute('poster', /^data:image\/jpeg/u);
  const video = await player.elementHandle();
  if (!video) throw new Error('Expected the live background player');
  // Simulate a decoder with no presentation-time progress while preserving
  // the actual player lifecycle, load/canplay events and watchdog timers.
  await video.evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'currentTime', { configurable: true, get: () => 0, set: () => {} });
    const load = element.load.bind(element);
    element.load = () => { element.dataset.recoveryLoads = String(Number(element.dataset.recoveryLoads ?? 0) + 1); load(); };
  });
  await page.clock.runFor(20_000);
  await expect(page.locator('[data-background-video-fallback="poster"]')).toBeVisible();
  expect(await video.getAttribute('data-recovery-loads')).toBe('1');
  await page.clock.runFor(20_000);
  expect(await video.getAttribute('data-recovery-loads')).toBe('1');
  await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
  await expect.poll(() => paused(page, '[data-background-layer] video')).toBe(false);
});

for (const surface of ['normal', 'private', 'channel'] as const) {
  test(`BG-H1 ${surface} protects shared narration without a feed-sized background`, async ({ page }, info) => {
    await page.addInitScript(() => {
      localStorage.setItem('ling-stack.locale', 'en-US');
      localStorage.setItem('ling-stack.themeSelection', JSON.stringify({ mode: 'fixed', themeId: 'ling-journey' }));
    });
    const state = createBaseState({ approvalStatus: 'expired' });
    const title = surface === 'normal' ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === 'private' ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === 'channel') {
      const { threadId } = installChannelWorkCellFixture(state, 'theme-reading');
      state.channelMessages.push({
        id: 'theme-reading-reply', workspaceId: 'workspace_default', channelId: 'channel_engineering', threadId,
        kind: 'ai_reply', intent: 'discuss', authorType: 'ai-teammate', authorId: 'ling_agent',
        body: 'Readable channel reply.', mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [],
        status: 'ready', createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z',
      });
    }
    // One fact keeps this reading check independent of the command-batch fold.
    state.executionActions = state.executionActions.slice(0, 1);
    state.terminalReports = [];
    state.conversationItems = state.conversationItems?.filter(item => item.kind !== 'terminal_report');
    await mockDaemon(page, state); await page.goto('/');
    if (title) await page.getByRole('button', { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole('button', { name: teammate.displayName, exact: true }).click();
    if (surface === 'channel') await openEngineeringChannel(page);
    const narration = page.locator('.conversation-timeline-message.agentMessage').first();
    await expect(narration.locator('.message-body-paragraph').first()).toBeVisible();
    const reading = narration.locator('.conversation-timeline-reading-body, [data-conversation-message-row] > .message-content').first();
    await expect(reading).toBeVisible();
    expect(await reading.evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(await narration.evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    const timeline = page.locator('[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]').first();
    await expandTimelineProcesses(timeline);
    await expect(timeline.locator('[data-conversation-timeline-kind="commandExecution"]').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`${surface}-shared-reading.png`) });
  });
}
