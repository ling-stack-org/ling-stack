import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mockDaemon } from './support/mock-daemon';
import { createBaseState, createChatProvider } from './support/mock-state';
import { installNormalWorkCellFixture, installTeammateWorkCellFixture, installChannelWorkCellFixture } from './support/conversation-work-cell-fixture';
import { openEngineeringChannel } from './support/test-helpers';

const designs = {
  'ling-breeze': { radius: '20px', background: 'rgb(255, 254, 251)', focus: 'rgb(52, 123, 68)', own: 'rgb(224, 238, 219)', menu: '14px', dialog: '20px', shell: .94, code: '10px', quote: 'rgb(155, 184, 157)' },
  'ling-night': { radius: '10px', background: 'rgb(41, 38, 42)', focus: 'rgb(231, 179, 139)', own: 'rgb(64, 58, 60)', menu: '8px', dialog: '10px', shell: .8, code: '6px', quote: 'rgb(140, 123, 133)' },
  'ling-ocean': { radius: '18px', background: 'rgb(255, 253, 249)', focus: 'rgb(180, 69, 54)', own: 'rgb(252, 227, 217)', menu: '14px', dialog: '18px', shell: .72, code: '10px', quote: 'rgb(149, 185, 190)' },
  'ling-journey': { radius: '14px', background: 'rgb(17, 28, 39)', focus: 'rgb(196, 154, 99)', own: 'rgb(48, 69, 86)', menu: '10px', dialog: '14px', shell: .68, code: '8px', quote: 'rgb(196, 154, 99)' },
} as const;
type Theme = keyof typeof designs;
type BuiltInTheme = Theme | 'ling-light' | 'ling-dark';
type Surface = 'home' | 'normal' | 'private' | 'channel';
const richText = 'Shared component reading sample.\n\n> A quiet reference line.\n\n```ts\nconst theme = "shared";\n```';

function textContrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const parts = color.match(/[\d.]+/gu)?.map(Number) ?? [];
    if (parts.length < 3 || (parts.length === 4 && parts[3] !== 1)) throw new Error(`Expected opaque RGB: ${color}`);
    return parts.slice(0, 3).map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  };
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + .05) / (Math.min(...values) + .05);
}

async function prepare(page: Page, theme: BuiltInTheme, surface: Surface) {
  await page.addInitScript(themeId => {
    localStorage.setItem('ling-stack.locale', 'en-US');
    const selection = JSON.stringify({ mode: 'fixed', themeId });
    localStorage.setItem('ling-stack.themeSelection', selection);
    localStorage.setItem('ling-stack.themeBootstrapSelection', selection);
  }, theme);
  const state = createBaseState({ approvalStatus: 'expired' });
  state.providers = [createChatProvider({ id: 'component-preview', lastCheck: { ok: true, code: 'ready', message: 'Isolated visual fixture', checkedAt: '2026-10-28T00:00:00Z' } })];
  const title = surface === 'normal' ? installNormalWorkCellFixture(state) : undefined;
  const teammate = surface === 'private' ? installTeammateWorkCellFixture(state) : undefined;
  if (surface === 'normal') {
    for (const events of Object.values(state.eventsByRun)) for (const event of events) {
      if (event.type === 'assistant_text_delta') event.data = { text: richText };
    }
  }
  if (surface === 'private') for (const message of state.teammateDirectMessages) {
    if (message.authorType === 'ai-teammate') message.body = richText;
  }
  if (surface === 'channel') {
    const { threadId } = installChannelWorkCellFixture(state, 'component-theme');
    state.channelMessages.push({ id: 'theme-reading', workspaceId: 'workspace_default', channelId: 'channel_engineering', threadId,
      kind: 'ai_reply', intent: 'discuss', authorType: 'ai-teammate', authorId: 'ling_agent', body: richText,
      mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: 'ready', createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' });
  }
  // WorkCell fixtures replace providers. Mark their existing IDs ready so all
  // surfaces exercise the same usable Composer without modifying real settings.
  state.providers = state.providers.map(provider => ({ ...provider,
    lastCheck: { ok: true, code: 'ready', message: 'Isolated visual fixture', checkedAt: '2026-10-28T00:00:00Z' },
  }));
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.approvals = [];
  state.terminalReports = [];
  state.conversationItems = state.conversationItems?.filter(item => item.kind !== 'terminal_report');
  await mockDaemon(page, state);
  await page.route('**/runtime/conversation-execution**', route => route.fulfill({ json: { cwd: new URL(route.request().url()).searchParams.get('cwd') ?? '', status: 'not_selected', defaultRunnerId: 'pi' } }));
  await page.goto('/');
  await expect(page.locator('.conversation-home')).toBeVisible();
  if (title) await page.getByRole('button', { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  if (teammate) await page.getByRole('button', { name: teammate.displayName, exact: true }).click();
  if (surface === 'channel') await openEngineeringChannel(page);
  await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme);
  await expect(page.locator('[data-conversation-composer]')).toBeVisible();
  await expect(page.locator('[data-conversation-composer]')).toHaveAttribute('data-surface', surface === 'private' ? 'teammate_direct' : surface === 'channel' ? 'channel' : 'normal_conversation');
  if (surface !== 'home') await expect(page.locator('.conversation-home')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function paint(page: Page) {
  return page.locator('[data-conversation-composer]').evaluate(async element => {
    getComputedStyle(element).borderColor;
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    const css = getComputedStyle(element);
    const toolbar = getComputedStyle(element.querySelector('.conversation-composer-toolbar')!);
    return { radius: css.borderRadius, background: css.backgroundColor, border: css.borderColor, shadow: css.boxShadow,
      finish: css.backgroundImage, decoration: getComputedStyle(element, '::before').backgroundImage,
      toolbar: toolbar.backgroundColor, toolbarBorder: toolbar.borderTopColor, toolbarFinish: toolbar.backgroundImage };
  });
}

async function capture(page: Page, info: TestInfo, name: string) {
  const directory = process.env.LING_COMPONENT_THEME_EVIDENCE ?? info.outputDir;
  await mkdir(directory, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations()
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
}

for (const [id, design] of Object.entries(designs)) {
  const theme = id as Theme;
  test(`${theme}: one component appearance across home, normal, channel and private`, async ({ browser }, info) => {
    test.setTimeout(90_000);
    const values: Record<string, { base: Awaited<ReturnType<typeof paint>>; focus: Awaited<ReturnType<typeof paint>> }> = {};
    for (const surface of ['home', 'normal', 'private', 'channel'] as const) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' });
      try {
        const page = await context.newPage();
        const failures: string[] = [];
        page.on('pageerror', error => failures.push(error.message));
        page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
        await prepare(page, theme, surface);
        const composer = page.locator('[data-conversation-composer]');
        await expect(composer).toHaveCSS('border-radius', design.radius);
        await expect(composer).toHaveCSS('background-color', design.background);
        await page.mouse.click(1400, 6);
        const base = await paint(page);
        expect(base.decoration === 'none').toBe(['ling-night', 'ling-breeze', 'ling-journey'].includes(theme));
        await expect(composer).toHaveCSS('background-image', ['ling-journey', 'ling-breeze'].includes(theme) ? 'none' : /linear-gradient/u);
        expect(await composer.evaluate(element => getComputedStyle(element, '::before').pointerEvents)).toBe('none');
        await capture(page, info, `${theme}-${surface}`);
        await composer.getByRole('textbox').fill('Keep this draft while comparing shared theme components.');
        await expect(composer.getByRole('textbox')).toBeFocused();
        await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
        await expect(composer).toHaveCSS('border-color', design.focus);
        const focused = await paint(page);
        expect(focused.shadow).not.toBe(base.shadow);
        expect(focused.decoration === 'none').toBe(['ling-night', 'ling-breeze', 'ling-journey'].includes(theme));
        values[surface] = { base, focus: focused };
        await capture(page, info, `${theme}-${surface}-focus`);
        if (surface === 'home') {
          const shell = await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--user-background-sidebar'));
          expect(Number.parseFloat(shell)).toBeCloseTo(design.shell * 100);
          const hidden = await page.addStyleTag({ content: '[data-background-layer] { visibility: hidden !important; }' });
          await capture(page, info, `${theme}-components-without-scene`);
          await hidden.evaluate(element => element.remove());
        } else {
          const own = page.locator('[data-conversation-message-row].message-bubble-own > .message-content').first();
          await expect(own).toBeVisible();
          await expect(own).toHaveCSS('background-color', design.own);
          await expect(own).toHaveCSS('border-radius', ['18px', '20px'].includes(design.radius) ? '16px' : design.radius);
          await expect(page.locator('.message-body-quote').first()).toHaveCSS('border-inline-start-color', design.quote);
          await expect(page.locator('.message-code-block').first()).toHaveCSS('border-radius', design.code);
          const heading = page.locator('.message-code-block figcaption').first();
          await expect(heading).toHaveCSS('background-color', theme === 'ling-breeze' ? 'rgb(234, 243, 232)' : theme === 'ling-night' ? 'rgb(52, 48, 54)' : theme === 'ling-ocean' ? 'rgb(226, 240, 238)' : 'rgb(21, 35, 46)');
          for (const surface of [page.locator('.message-body-quote').first(), heading]) {
            const colors = await surface.evaluate(element => ({ text: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
            expect(textContrast(colors.text, colors.background), JSON.stringify(colors)).toBeGreaterThanOrEqual(4.5);
          }
          await expect(own).not.toHaveCSS('box-shadow', 'none');
          const reading = page.locator('.conversation-timeline-reading-body').first();
          if (await reading.count()) expect(await reading.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
        }
        expect(failures).toEqual([]);
      } finally { await context.close(); }
    }
    for (const surface of ['normal', 'private', 'channel']) expect(values[surface], surface).toEqual(values.home);
    const directory = process.env.LING_COMPONENT_THEME_EVIDENCE ?? info.outputDir;
    await writeFile(resolve(directory, `${theme}-shared-components.json`), JSON.stringify(values, null, 2));
  });

  test(`${theme}: controls, overlay geometry, errors and accessibility states`, async ({ page }, info) => {
    await prepare(page, theme, 'home');
    const composer = page.locator('[data-conversation-composer]');
    const send = composer.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeDisabled();
    const disabled = await send.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, opacity: getComputedStyle(element).opacity }));
    await send.hover();
    await expect(send).toHaveCSS('background-color', disabled.background);
    expect(disabled.opacity).toBe('0.48');
    await page.mouse.move(1400, 6);
    await composer.getByRole('textbox').fill('Theme interaction preview');
    await expect(send).toBeEnabled();
    const idle = await send.evaluate(element => getComputedStyle(element).backgroundColor);
    await send.hover();
    await expect.poll(() => send.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(idle);
    await page.mouse.down();
    await capture(page, info, `${theme}-button-pressed`);
    await page.mouse.move(1400, 6);
    await page.mouse.up();
    let finishUpload!: () => void;
    const uploadPending = new Promise<void>(resolve => { finishUpload = resolve; });
    await page.route('**/conversations/attachments?**', async route => {
      await uploadPending;
      await route.fulfill({ status: 500, json: { error: 'preview_upload_failed', message: 'Controlled theme preview error' } });
    });
    try {
      await composer.locator('input[type="file"]').setInputFiles({ name: 'theme-preview.txt', mimeType: 'text/plain', buffer: Buffer.from('theme preview') });
      await expect(composer.locator('.composer-preview-card.uploading')).toBeVisible();
      await capture(page, info, `${theme}-loading`);
    } finally { finishUpload(); }
    await expect(composer.locator('.composer-preview-card.failed')).toBeVisible();
    await capture(page, info, `${theme}-error`);
    await page.getByRole('button', { name: 'Channel actions', exact: true }).first().click();
    await expect(page.getByRole('menu')).toHaveCSS('border-radius', design.menu);
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'New channel', exact: true })).toBeFocused();
    await capture(page, info, `${theme}-menu`);
    await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCSS('border-radius', design.dialog);
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await expect(page.getByRole('dialog')).toHaveCSS('background-color', theme === 'ling-breeze' ? 'rgb(255, 254, 251)' : theme === 'ling-night' ? 'rgb(52, 48, 54)' : theme === 'ling-ocean' ? 'rgb(255, 253, 249)' : 'rgb(24, 37, 49)');
    await capture(page, info, `${theme}-dialog`);
    await page.keyboard.press('Escape');
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await expect(page.locator('[data-background-layer]')).toBeHidden();
    await composer.getByRole('textbox').focus();
    await expect(composer).toHaveCSS('outline-style', 'solid');
    await expect(composer).toHaveCSS('outline-width', '2px');
    await expect(composer).toHaveCSS('background-image', 'none');
    expect(await composer.evaluate(element => getComputedStyle(element, '::before').display)).toBe('none');
    await page.getByRole('button', { name: 'Channel actions', exact: true }).first().click();
    await expect(page.getByRole('menu')).toHaveCSS('background-image', 'none');
    await page.keyboard.press('Escape');
    await capture(page, info, `${theme}-forced-colors`);
  });
}

test('theme switching restores component defaults and material bases', async ({ page }) => {
  await prepare(page, 'ling-ocean', 'home');
  const nav = page.getByRole('complementary', { name: /Sidebar display|侧栏显示/u });
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Settings sections').getByRole('button', { name: 'Interface preferences', exact: true }).click();
  for (const [theme, radius] of [['ling-night', '10px'], ['ling-journey', '14px'], ['ling-dark', '14px'], ['ling-light', '14px'], ['ling-breeze', '20px'], ['ling-ocean', '18px']]) {
    await page.locator(`[data-theme-option-id="${theme}"]`).click();
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await expect(page.locator('[data-conversation-composer]')).toHaveCSS('border-radius', radius);
    const material = await paint(page);
    expect(material.decoration === 'none').toBe(['ling-night', 'ling-dark', 'ling-light', 'ling-breeze', 'ling-journey'].includes(theme));
    expect(material.finish === 'none').toBe(!['ling-ocean', 'ling-night'].includes(theme));
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Settings sections').getByRole('button', { name: 'Interface preferences', exact: true }).click();
  }
});

test('theme surface details preserve control hits, focus and narrow-window layout', async ({ browser }, info) => {
  test.setTimeout(90_000);
  const signatures: Record<string, unknown> = {};
  for (const [theme, navRadius, markerWidth, markerHeight, shortcutRadius] of [
    ['ling-breeze', '10px', '0px', '18px', '20px'],
    ['ling-night', '4px', '3px', '16px', '4px'],
    ['ling-ocean', '18px', '0px', '18px', '18px'],
    ['ling-journey', '8px', '18px', '1px', '8px'],
  ] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await prepare(page, theme, 'home');
      const navigation = page.getByRole('complementary', { name: /Sidebar display|侧栏显示/u });
      await expect(navigation.getByRole('button', { name: 'New conversation', exact: true })).toHaveCSS('border-radius', navRadius);
      await navigation.getByRole('button', { name: 'Plugin Manager', exact: true }).click();
      const selected = page.locator('.channel-left-drawer .nav-item.active').first();
      await expect(selected).toHaveCSS('border-radius', navRadius);
      const marker = await selected.evaluate(element => {
        const css = getComputedStyle(element, '::after');
        return { width: css.width, height: css.height, top: css.top, bottom: css.bottom, transform: css.transform, pointer: css.pointerEvents };
      });
      expect(marker.width).toBe(markerWidth);
      expect(marker.height).toBe(markerHeight);
      expect(marker.pointer).toBe('none');
      await capture(page, info, `${theme}-navigation-narrow`);
      await navigation.getByRole('button', { name: 'New conversation', exact: true }).click();
      const slides = page.getByRole('button', { name: 'Slides', exact: true });
      await expect(slides).toHaveCSS('border-radius', shortcutRadius);
      await slides.click();
      const input = page.locator('[data-conversation-composer]').getByRole('textbox');
      await expect(input).not.toBeEmpty();
      await input.click();
      await expect(input).toBeFocused();
      await input.fill('A readable draft, with stable control targets.');
      await page.getByRole('button', { name: 'Channel actions', exact: true }).first().click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const header = dialog.locator('.ling-ui-dialog-header');
      await expect(header).toHaveCSS('background-color', theme === 'ling-breeze' ? 'rgb(237, 245, 235)' : theme === 'ling-night' ? 'rgb(52, 48, 54)' : theme === 'ling-ocean' ? 'rgb(237, 247, 245)' : 'rgb(21, 33, 44)');
      await capture(page, info, `${theme}-detail-dialog-narrow`);
      await page.keyboard.press('Escape');
      await expect(input).toHaveText('A readable draft, with stable control targets.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const hidden = await page.addStyleTag({ content: '[data-background-layer] { visibility: hidden !important; }' });
      await capture(page, info, `${theme}-detail-without-scene-narrow`);
      await hidden.evaluate(element => element.remove());
      signatures[theme] = { marker, composer: await paint(page) };
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
  expect(new Set(Object.values(signatures).map(value => JSON.stringify(value))).size).toBe(4);
  const directory = process.env.LING_COMPONENT_THEME_EVIDENCE ?? info.outputDir;
  await writeFile(resolve(directory, 'theme-surface-details.json'), JSON.stringify(signatures, null, 2));
});

test('theme card materials carry through teammate management and model tables', async ({ browser }, info) => {
  test.setTimeout(60_000);
  for (const [theme, radius] of [['ling-breeze', '14px'], ['ling-night', '8px'], ['ling-ocean', '14px'], ['ling-journey', '10px']] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' });
    try {
      const page = await context.newPage();
      await prepare(page, theme, 'private');
      await page.getByRole('complementary', { name: /Sidebar display|侧栏显示/u }).getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByLabel('Settings sections');
      await settings.getByRole('button', { name: 'Teammate Management', exact: true }).click();
      const card = page.locator('.teammate-management-list-panel');
      await expect(card).toHaveCSS('border-radius', radius);
      await expect(card).toHaveCSS('background-color', designs[theme].background);
      await expect(card.locator('.teammate-draft-row')).toHaveCount(1);
      await capture(page, info, `${theme}-teammates`);
      await settings.getByRole('button', { name: 'Model Workbench', exact: true }).click();
      const table = page.locator('.provider-table').locator('..');
      await expect(table).toHaveCSS('border-radius', radius);
      await expect(table).toHaveCSS('background-color', designs[theme].background);
      await expect(page.locator('.provider-table tbody tr')).toHaveCount(1);
      await capture(page, info, `${theme}-models`);
    } finally { await context.close(); }
  }
});
