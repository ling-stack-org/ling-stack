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

test('BG-H3 recommendations follow edited parameters and actions occupy one row', async ({ page }) => {
  await prepare(page); await settings(page);
  const panel = page.locator('[data-background-settings]');
  const recommend = panel.getByRole('button', { name: 'Use recommended settings', exact: true });
  await expect(recommend).toHaveCount(0);
  await expect(panel.locator('.background-actions')).toHaveCount(1);
  await expect(panel.locator('[data-background-preview]')).toHaveAttribute('data-draft', 'false');

  await panel.locator('[data-background-opacity]').press('End');
  await expect(panel.locator('[role="status"]')).toContainText('Preview only');
  await expect(panel.locator('[data-background-preview]')).toHaveAttribute('data-draft', 'true');
  await expect(recommend).toBeVisible();
  const boxes = await panel.locator('.background-actions button').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect();
    return { top: box.top, left: box.left, right: box.right };
  }));
  expect(boxes).toHaveLength(4);
  for (const [index, box] of boxes.entries()) {
    expect(Math.abs(box.top - boxes[0].top)).toBeLessThanOrEqual(1);
    if (index) expect(box.left - boxes[index - 1].right).toBeGreaterThanOrEqual(7);
  }
  await recommend.click();
  await expect(recommend).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply background', exact: true })).toHaveCount(0);
  await expect(panel.locator('[data-background-preview]')).toHaveAttribute('data-draft', 'false');

  await panel.locator('[data-background-focus="x"]').press('End');
  await expect(recommend).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel preview', exact: true }).click();
  await expect(recommend).toHaveCount(0);

  // A media draft alone is not a deviation from the recommended profile.
  await panel.locator('[data-background-file]').setInputFiles({ name: 'profile.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(panel.locator('.background-preview video')).toBeVisible();
  await expect(recommend).toHaveCount(0);
  await panel.getByRole('button', { name: 'Pause · Background', exact: true }).click();
  await expect(recommend).toBeVisible();
  await recommend.click();
  await expect(recommend).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply background', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel preview', exact: true }).click();
});

test('BG-H4 saves and clear use one expiring global success Toast without inline success state', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await prepare(page); await settings(page);
  const panel = page.locator('[data-background-settings]');
  const toast = page.locator('.ling-ui-toast[data-scope="settings:background:save"]');
  const slider = panel.locator('[data-background-opacity]');
  await slider.fill('80'); await apply(page);
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('Background saved.');
  await expect(toast).toHaveAttribute('data-tone', 'success');
  await expect(panel.getByRole('status')).not.toContainText('Background saved.');
  await expect(panel.locator('.ling-ui-toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('background-save-global-toast.png') });
  await page.clock.runFor(2_400); await expect(toast).toBeVisible();
  // A second result reuses the scope and gets the full shared lifetime.
  await slider.fill('70'); await apply(page);
  await expect(toast).toHaveCount(1);
  await page.clock.runFor(2_400); await expect(toast).toBeVisible();
  await page.clock.runFor(1_000); await expect(toast).toHaveCount(0);
  await expect(slider).toHaveValue('70');
  await panel.locator('[data-background-file]').setInputFiles({ name: 'toast.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(panel.locator('[data-background-preview]')).toHaveAttribute('data-draft', 'true');
  await apply(page);
  await panel.getByRole('button', { name: 'Restore default background', exact: true }).click();
  await expect(toast).toHaveCount(1);
  await expect(page.locator('html')).toHaveAttribute('data-background-source', 'theme-scene');
  await page.clock.runFor(3_400); await expect(toast).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('background-save-toast-expired.png') });
  expect(errors).toEqual([]);
});

test('BG-H4 a failed save dismisses old success and keeps local error until successful recovery', async ({ page }, info) => {
  await page.clock.install();
  await prepare(page); await settings(page);
  const panel = page.locator('[data-background-settings]');
  const toast = page.locator('.ling-ui-toast[data-scope="settings:background:save"]');
  const slider = panel.locator('[data-background-opacity]');
  await slider.fill('80'); await apply(page); await expect(toast).toBeVisible();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    Reflect.set(window, '__backgroundFeedbackPut', put);
    IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'background-settings') throw new DOMException('Controlled write failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await slider.fill('70'); await apply(page);
  await expect(panel.getByRole('alert')).toBeVisible();
  await page.clock.runFor(6_000);
  await expect(toast).toHaveCount(0);
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(slider).toHaveValue('80');
  await page.screenshot({ path: info.outputPath('background-save-persistent-error.png') });
  await page.evaluate(() => { IDBObjectStore.prototype.put = Reflect.get(window, '__backgroundFeedbackPut'); });
  await slider.fill('60'); await apply(page);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(toast).toBeVisible();
});

for (const themeId of ['ling-breeze', 'ling-ocean', 'ling-night', 'ling-journey']) {
  test(`BG-H3 ${themeId} previews the full range and persists visibility after apply`, async ({ page }, info) => {
    await prepare(page); await settings(page);
    await page.locator(`[data-theme-option-id="${themeId}"]`).click();
    const exposure = () => page.evaluate(() => {
      const scrim = Number(getComputedStyle(document.querySelector('.workspace-background-scrim')!).opacity);
      const color = getComputedStyle(document.querySelector('.workspace')!).backgroundColor;
      const match = color.match(/\/\s*([\d.]+)\)$/u) ?? color.match(/^rgba\(.+,\s*([\d.]+)\)$/u);
      const tint = color === 'transparent' ? 0 : match ? Number(match[1]) : 1;
      return (1 - scrim) * (1 - tint);
    });
    await back(page);
    await expect(page.locator('.workspace-background-scrim')).toHaveCSS('opacity', '0.4');
    const balancedExposure = await exposure();
    expect(balancedExposure).toBeGreaterThan(.5);
    expect(balancedExposure).toBeLessThanOrEqual(.6);
    await page.screenshot({ path: info.outputPath(`${themeId}-visibility-60.png`) });
    await settings(page);
    await page.setViewportSize({ width: 1280, height: 960 });
    const slider = page.locator('[data-background-opacity]');
    const scrim = page.locator('.background-preview-scrim');
    await slider.press('Home');
    await expect(scrim).toHaveCSS('opacity', '0.8');
    await slider.press('End');
    await expect(slider).toHaveValue('100');
    await expect(scrim).toHaveCSS('opacity', '0');
    await expect(page.locator('.background-preview-shell > span').nth(1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: 'Apply background', exact: true }).click();
    await back(page);
    await expect(page.locator('.workspace-background-scrim')).toHaveCSS('opacity', '0.4');
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(page.locator('.workspace-background-scrim')).toHaveCSS('opacity', '0');
    expect(await exposure()).toBe(1);
    expect(await exposure() - balancedExposure).toBeGreaterThan(.3);
    const title = page.locator('.conversation-home h1');
    await expect(title).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(title).toHaveCSS('-webkit-text-stroke-width', '2px');
    await expect(title).toHaveCSS('paint-order', 'stroke');
    await page.screenshot({ path: info.outputPath(`${themeId}-visibility-100.png`) });
    await page.reload(); await settings(page);
    await expect(slider).toHaveValue('100');
    const recommend = page.getByRole('button', { name: 'Use recommended settings', exact: true });
    await recommend.click();
    await expect(slider).toHaveValue('60');
    await expect(recommend).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
    await expect(slider).toHaveValue('100');
    await expect(recommend).toBeVisible();
  });
}

test('BG-H4 all six themes keep section padding, real card gaps and complete borders', async ({ page }, info) => {
  await prepare(page); await settings(page);
  for (const themeId of ['ling-light', 'ling-dark', 'ling-breeze', 'ling-ocean', 'ling-night', 'ling-journey']) {
    await page.locator(`[data-theme-option-id="${themeId}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', themeId);
    const cards = await page.locator('.settings-interface-section').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(), css = getComputedStyle(element);
      const heading = element.querySelector('h2')!.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, inset: heading.top - box.top,
        padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft], border: css.borderBottomWidth };
    }));
    expect(cards).toHaveLength(3);
    for (const [index, card] of cards.entries()) {
      expect(card.padding).toEqual(['24px', '24px', '24px', '24px']);
      expect(card.inset).toBeGreaterThanOrEqual(24);
      expect(card.border).toBe('1px');
      if (index) expect(card.top - cards[index - 1].bottom).toBe(16);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`${themeId}-settings-spacing.png`) });
  }
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
