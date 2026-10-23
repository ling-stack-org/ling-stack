import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";

// Exercise the real sandboxed preload, main-frame checks and native Menu API.
// Requires compiled main/preload outputs; no daemon or external app is launched.
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "ling-local-file-smoke-"));
let app;
try {
  const code = join(root, "中文 示例.py");
  const archive = join(root, "工程包.zip");
  const html = join(root, "index.html");
  const entry = join(root, "main.cjs");
  await writeFile(code, "print('你好')\n");
  await writeFile(archive, "PK fixture");
  await writeFile(html, `<!doctype html><meta charset="utf-8"><title>Local file smoke</title>
    <button id="code">Code</button><button id="archive">Archive</button><output id="result"></output>
    <script>
      const code = ${JSON.stringify(code)}, archive = ${JSON.stringify(archive)};
      for (const [id, path] of [['code', code], ['archive', archive]]) {
        const button = document.getElementById(id);
        button.dataset.localFilePath = path;
        button.dataset.localFileCwd = '';
        const run = async (menu) => {
          try { const result = await window.lingDesktop.localFiles[menu ? 'showMenu' : 'inspect']({path, locale:'zh-CN'}); window.result = result ?? null; }
          catch (error) { window.result = {error: error.message}; }
        };
        button.onclick = () => run(false);
        button.oncontextmenu = (event) => { event.preventDefault(); run(true); };
      }
    </script>`);
  await writeFile(entry, `const { app, BrowserWindow, ipcMain, Menu } = require('electron');
    const build = Menu.buildFromTemplate;
    Menu.buildFromTemplate = (template) => {
      const menu = build.call(Menu, template);
      global.lastMenu = menu;
      return menu;
    };
    app.whenReady().then(async () => {
      const { registerLocalFileIpc } = await import(${JSON.stringify(pathToFileURL(join(desktop, "dist/main/local-files/ipc.js")).href)});
      const window = new BrowserWindow({width:800, height:600, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false, preload:${JSON.stringify(join(desktop, "dist/preload/main-window.cjs"))}}});
      registerLocalFileIpc({ipcMainImpl:ipcMain, getMainWindow:()=>window, trustedDocumentUrl:${JSON.stringify(pathToFileURL(html).href)}});
      await window.loadFile(${JSON.stringify(html)});
    });`);
  app = await electron.launch({ executablePath: electronPath, args: [entry, `--user-data-dir=${join(root, "profile")}`], timeout: 20_000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.lingDesktop?.localFiles));
  const denied = await page.evaluate(async (path) => {
    try { await window.lingDesktop.localFiles.inspect({ path }); return "allowed"; }
    catch (error) { return error.message; }
  }, code);
  assert.match(denied, /user_activation_required/u);
  await page.locator("#code").click();
  await page.waitForFunction(() => window.result?.kind === "text");
  assert.equal((await page.evaluate(() => window.result)).text, "print('你好')\n");
  await page.evaluate(() => { window.result = null; document.getElementById("code").click(); });
  await page.waitForFunction(() => Boolean(window.result?.error));
  assert.match((await page.evaluate(() => window.result)).error, /user_activation_required/u);
  await page.locator("#archive").click();
  await page.waitForFunction(() => window.result?.kind === "unsupported");
  await page.evaluate(() => { window.result = null; });
  await page.locator("#archive").click({ button: "right" });
  let labels = [];
  await expect.poll(async () => {
    labels = await app.evaluate(() => global.lastMenu?.items.map((item) => ({ label: item.label, children: item.submenu?.items.map((child) => child.label) })) ?? []);
    return labels.some((item) => item.label === "在 Ling 中预览");
  }, { timeout: 10_000 }).toBe(true);
  assert.ok(labels.some((item) => item.label === "在 Ling 中预览"), JSON.stringify({ labels, result: await page.evaluate(() => window.result) }));
  assert.ok(labels.some((item) => item.label === "复制路径"));
  const openWith = labels.find((item) => item.label === "打开方式");
  assert.ok(openWith?.children.includes("选择其他应用…"));
  if (process.platform === "darwin") assert.ok(openWith.children.length > 1, "Launch Services should return installed ZIP applications");
  await app.evaluate(() => {
    // Select the actual native MenuItem callback without opening an external app.
    const item = global.lastMenu.items.find((item) => item.label === "在 Ling 中预览");
    item.click();
    global.lastMenu.closePopup();
  });
  await page.waitForFunction(() => window.result?.kind === "unsupported");
  process.stdout.write(`Electron local-file smoke passed: real click, synthetic denial, ZIP preview, native menu (${openWith.children.filter(Boolean).join(", ")})\n`);
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
