import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mockDaemon } from './support/mock-daemon';
import { createBaseState, createChatProvider } from './support/mock-state';
import { installNormalWorkCellFixture, installTeammateWorkCellFixture, installChannelWorkCellFixture } from './support/conversation-work-cell-fixture';
import { openEngineeringChannel } from './support/test-helpers';

const themes = ['ling-breeze', 'ling-ocean', 'ling-night'] as const;
type PhotoTheme = typeof themes[number];
const evidenceDirectory = process.env.LING_PHOTO_THEME_EVIDENCE;
const sceneExports = {
  'ling-breeze': { file: 'forest-clearing-v1.webp', width: 1672, height: 941 },
  'ling-ocean': { file: 'summer-manga-v1.webp', width: 1344, height: 756 },
  'ling-night': { file: 'valley-overlook-v1.webp', width: 3840, height: 2160 },
} as const;

async function prepare(page: Page, themeId: PhotoTheme, surface?: 'normal' | 'private' | 'channel') {
  await page.addInitScript(id => {
    localStorage.setItem('ling-stack.locale', 'en-US');
    const selection = JSON.stringify({ mode: 'fixed', themeId: id });
    localStorage.setItem('ling-stack.themeSelection', selection);
    localStorage.setItem('ling-stack.themeBootstrapSelection', selection);
  }, themeId);
  const state = createBaseState({ approvalStatus: 'expired' });
  state.providers = [createChatProvider({ id: 'photo-fixture', lastCheck: { ok: true, code: 'ready', message: 'Isolated visual fixture', checkedAt: '2026-10-27T00:00:00Z' } })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.approvals = [];
  const title = surface === 'normal' ? installNormalWorkCellFixture(state) : undefined;
  const teammate = surface === 'private' ? installTeammateWorkCellFixture(state) : undefined;
  if (surface === 'channel') {
    const { threadId } = installChannelWorkCellFixture(state, 'photo-reading');
    state.channelMessages.push({
      id: 'photo-reading-reply', workspaceId: 'workspace_default', channelId: 'channel_engineering', threadId,
      kind: 'ai_reply', intent: 'discuss', authorType: 'ai-teammate', authorId: 'ling_agent',
      body: 'Readable channel reply.', mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [],
      status: 'ready', createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z',
    });
  }
  if (surface) {
    state.executionActions = state.executionActions.slice(0, 1);
    state.terminalReports = [];
    state.conversationItems = state.conversationItems?.filter(item => item.kind !== 'terminal_report');
  }
  await mockDaemon(page, state);
  // The base daemon fixture excludes the automation feature. Supply its real
  // empty-list response shapes so this visual check never falls through to a
  // running daemon or mistakes a fixture 404 for an application error.
  await page.route('http://127.0.0.1:17891/**', route => {
    const url = new URL(route.request().url());
    const cwd = url.searchParams.get('cwd') ?? '';
    if (route.request().method() !== 'GET') return route.fallback();
    if (url.pathname === '/automations') return route.fulfill({ json: { cwd, automations: [], templates: [] } });
    if (url.pathname === '/automation-drafts') return route.fulfill({ json: { cwd, drafts: [], templates: [] } });
    if (url.pathname === '/automation-runs') return route.fulfill({ json: { cwd, automationRuns: [] } });
    if (url.pathname === '/automations/scheduler') return route.fulfill({ json: { cwd, schedulers: [] } });
    return route.fallback();
  });
  await page.route('**/runtime/conversation-execution**', route => route.fulfill({ json: { cwd: new URL(route.request().url()).searchParams.get('cwd') ?? '', status: 'not_selected', defaultRunnerId: 'pi' } }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ui-theme', themeId);
  await expect(page.locator('.conversation-home')).toBeVisible();
  return { title, teammate };
}

async function settings(page: Page) {
  await page.getByRole('complementary', { name: /Sidebar display|侧栏显示/u }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Settings sections').getByRole('button', { name: 'Interface preferences', exact: true }).click();
  await expect(page.locator('[data-ui2-interface-preferences]')).toBeVisible();
}

async function capture(page: Page, info: TestInfo, name: string) {
  const directory = evidenceDirectory ?? info.outputDir;
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

function errors(page: Page) {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(`${message.text()} [${message.location().url}]`); });
  return failures;
}

for (const theme of themes) {
  test(`${theme}: scene home, semantic legacy UI, management and protected surfaces`, async ({ page }, info) => {
    const failures = errors(page);
    await prepare(page, theme);
    const scene = page.locator('[data-background-layer] svg');
    await expect(scene).toBeVisible();
    const asset = await scene.locator('image').getAttribute('href');
    const expected = sceneExports[theme];
    expect(asset).toBe(`/themes/${theme}/${expected.file}`);
    const decoded = await page.evaluate(async path => {
      const image = new Image(); image.src = path!; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, asset);
    // Match each actual source export; do not upscale a smaller source just to
    // satisfy a generic "HD" assertion. Ocean's source is natively 1344x768.
    expect(decoded).toEqual({ width: expected.width, height: expected.height });
    await expect(scene.locator('path, circle, ellipse')).toHaveCount(0);
    await expect(page.locator('[data-background-layer] video')).toHaveCount(0);
    const aliases = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return [['--ling-text-default', '--ling-text-default'], ['--ling-action-accent', '--ling-action-accent'],
        ['--ling-bg-code', '--ling-bg-code'], ['--ling-bg-panel', '--ling-bg-panel']]
        .map(([legacy, semantic]) => ({ legacy, actual: style.getPropertyValue(legacy).trim(), expected: style.getPropertyValue(semantic).trim() }));
    });
    for (const alias of aliases) expect(alias.actual, alias.legacy).toBe(alias.expected);
    if (theme === 'ling-breeze') {
      const palette = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ['--ling-action-accent', '--ling-bg-sidebar', '--ling-bg-composer', '--ling-action-selection']
          .map(name => style.getPropertyValue(name).trim());
      });
      expect(palette).toEqual(['#347b44', '#e3eee5', '#fffefb', '#c7dfc8']);
    }
    if (theme === 'ling-ocean') {
      const palette = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ['--ling-action-accent', '--ling-bg-sidebar', '--ling-bg-composer', '--ling-action-selection']
          .map(name => style.getPropertyValue(name).trim());
      });
      expect(palette).toEqual(['#b44536', '#e1f1f1', '#fffdf9', '#fce3d9']);
    }
    if (theme === 'ling-night') {
      // Check the rendered CSS matches the selected scene's warm metal palette,
      // including actual composer paint rather than only registry values.
      const palette = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ['--ling-action-accent', '--ling-bg-sidebar', '--ling-bg-composer', '--ling-action-selection']
          .map(name => style.getPropertyValue(name).trim());
      });
      expect(palette).toEqual(['#e7b38b', '#262328', '#29262a', '#514039']);
      expect(await page.getByLabel('New conversation composer', { exact: true }).evaluate(element => getComputedStyle(element).backgroundColor))
        .toBe('rgb(41, 38, 42)');
    }
    const home = await capture(page, info, `${theme}-home`);
    const composer = page.getByLabel('New conversation composer', { exact: true });
    await composer.getByRole('textbox').fill('Theme preview draft');
    await expect(composer.getByRole('textbox')).toBeFocused();
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await capture(page, info, `${theme}-composer-focus`);
    await composer.getByRole('textbox').fill('');
    await page.getByRole('button', { name: 'Channel actions', exact: true }).first().click();
    await expect(page.getByRole('menu')).toBeVisible();
    await capture(page, info, `${theme}-menu`);
    await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture(page, info, `${theme}-dialog`);
    await page.keyboard.press('Escape');
    const nav = page.getByRole('complementary', { name: /Sidebar display|侧栏显示/u });
    for (const name of ['Plugin Manager', 'Automations']) {
      await nav.getByRole('button', { name, exact: true }).click();
      await expect(page.locator('[data-background-layer]')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-ui-surface-recipe', 'translucent');
      await capture(page, info, `${theme}-${name.toLowerCase()}`);
    }
    await settings(page);
    await expect(page.locator('[data-background-layer]')).toBeHidden();
    const thumbnail = page.locator(`[data-theme-option-id="${theme}"] image`);
    await expect(thumbnail).toHaveAttribute('href', asset!.replace('.webp', '-thumb.webp'));
    await capture(page, info, `${theme}-settings`);
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme-first-paint', theme);
    await expect(page.locator('[data-background-layer]')).toBeVisible();
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(page.locator('[data-background-layer]')).toBeHidden();
    await page.emulateMedia({ forcedColors: 'none' });
    await page.setViewportSize({ width: 1170, height: 800 });
    await expect(page.locator('[data-background-layer]')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await capture(page, info, `${theme}-narrow`);
    expect(failures).toEqual([]);
    await writeFile(resolve(evidenceDirectory ?? info.outputDir, `${theme}-evidence.json`), JSON.stringify({ theme, asset, decoded, aliases, home, failures, viewport: { width: 1440, height: 960 }, scope: 'Local Chromium, isolated daemon fixture, actual production components and CSS; no model invocation' }, null, 2));
  });

  for (const surface of ['normal', 'private', 'channel'] as const) {
    test(`${theme}: ${surface} reading remains opaque with transparent layout`, async ({ page }, info) => {
      const failures = errors(page);
      const { title, teammate } = await prepare(page, theme, surface);
      if (title) await page.getByRole('button', { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
      if (teammate) await page.getByRole('button', { name: teammate.displayName, exact: true }).click();
      if (surface === 'channel') await openEngineeringChannel(page);
      const narration = page.locator('.conversation-timeline-message.agentMessage').first();
      const reading = narration.locator('.conversation-timeline-reading-body, [data-conversation-message-row] > .message-content').first();
      await expect(reading).toBeVisible();
      expect(await reading.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      expect(await narration.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      await expect(page.locator('[data-background-layer]')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-background-source', 'theme-scene');
      expect(Number(await page.locator('.workspace-background-scrim').evaluate(element => getComputedStyle(element).opacity))).toBeGreaterThanOrEqual(0.55);
      await capture(page, info, `${theme}-${surface}`);
      expect(failures).toEqual([]);
    });
  }
}
