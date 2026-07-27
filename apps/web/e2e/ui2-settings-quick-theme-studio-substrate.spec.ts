import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { fileURLToPath } from "node:url";

const validPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("Quick Theme Studio analyzes valid local bytes without network and rejects unsafe image input", async ({ page }) => {
  await openSubstratePage(page);
  await exposeModule(page, "__quickThemeImage", "/src/shared/ui/theme/studio/web-quick-theme-image.ts");

  const result = await page.evaluate(async (pngBase64) => {
    const module = readModule("__quickThemeImage") as {
      analyzeWebQuickThemeImage: (file: File, signal?: AbortSignal) => Promise<{
        analysis: { averageLuminance: number; height: number; width: number };
        byteLength: number;
        checksumSha256: string;
        displayName: string;
        height: number;
        mimeType: string;
        width: number;
      }>;
    };
    const png = Uint8Array.from(atob(pngBase64), (value) => value.charCodeAt(0));
    const originalFetch = window.fetch;
    let fetchCount = 0;
    window.fetch = (...args) => {
      fetchCount += 1;
      return originalFetch(...args);
    };
    try {
      const analyzed = await module.analyzeWebQuickThemeImage(new File([png], "quiet-source.png", {
        type: "application/octet-stream",
      }));
      const mismatchCode = await issueCode(() => module.analyzeWebQuickThemeImage(
        new File([png], "quiet-source.jpg", { type: "image/jpeg" }),
      ));
      const corrupt = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
      const corruptCode = await issueCode(() => module.analyzeWebQuickThemeImage(
        new File([corrupt], "corrupt.png", { type: "image/png" }),
      ));
      const controller = new AbortController();
      controller.abort();
      const abortedCode = await issueCode(() => module.analyzeWebQuickThemeImage(
        new File([png], "cancelled.png", { type: "image/png" }),
        controller.signal,
      ));
      return {
        abortedCode,
        analyzed,
        corruptCode,
        fetchCount,
        mismatchCode,
      };
    } finally {
      window.fetch = originalFetch;
    }

    async function issueCode(run: () => Promise<unknown>): Promise<string | undefined> {
      try {
        await run();
        return undefined;
      } catch (error) {
        return (error as { issue?: { code?: string } }).issue?.code;
      }
    }

    function readModule(name: string): unknown {
      return (window as unknown as Record<string, unknown>)[name];
    }
  }, validPngBase64);

  expect(result.analyzed).toMatchObject({
    analysis: { height: 1, width: 1 },
    displayName: "quiet-source.png",
    height: 1,
    mimeType: "image/png",
    width: 1,
  });
  expect(result.analyzed.byteLength).toBeGreaterThan(0);
  expect(result.analyzed.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.fetchCount).toBe(0);
  expect(result.mismatchCode).toBe("invalid-mime");
  expect(result.corruptCode).toBe("decode-failed");
  expect(result.abortedCode).toBe("aborted");
});

test("IndexedDB v2 upgrades to v3 and stores Quick draft metadata and source Blob atomically", async ({ page }) => {
  await openSubstratePage(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const remove = indexedDB.deleteDatabase("ling-stack-ui2");
      remove.onsuccess = () => resolve();
      remove.onerror = () => reject(remove.error);
      remove.onblocked = () => reject(new Error("Theme database delete was blocked."));
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ling-stack-ui2", 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("themes", { keyPath: "id" });
        database.createObjectStore("theme-packages", { keyPath: "themeId" });
        const assets = database.createObjectStore("theme-assets", { keyPath: "key" });
        assets.createIndex("themeId", "themeId", { unique: false });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("themes", "readwrite");
        transaction.objectStore("themes").put({ id: "legacy-v2-theme", name: "Legacy V2" });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await exposeModule(page, "__quickThemeDrafts", "/src/shared/ui/theme/studio/web-theme-draft-repository.ts");

  const result = await page.evaluate(async () => {
    const module = readModule("__quickThemeDrafts") as {
      deleteWebQuickThemeDraft: (draftId: string) => Promise<void>;
      putWebQuickThemeDraft: (publication: unknown) => Promise<unknown>;
      readWebQuickThemeDraft: (draftId: string) => Promise<{
        id: string;
        name: string;
        sourceBlob?: Blob;
      } | undefined>;
    };
    const analysis = {
      width: 1,
      height: 1,
      aspectRatio: 1,
      averageLuminance: 0.5,
      dominantColors: ["#808080"],
      accentCandidate: "#808080",
      leftInformationScore: 0,
      rightInformationScore: 0,
      focusX: 0.5,
      focusY: 0.5,
      safeArea: "center",
      recommendedProfileId: "ling-standard",
    };
    const sourceBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    const draft = {
      analysis,
      artworkIntensity: "balanced",
      colorScheme: "light",
      createdAt: "2026-07-20T00:00:00.000Z",
      id: "draft-quick-1",
      name: "Quiet Draft",
      presentationProfileId: "ling-standard",
      revision: 2,
      source: {
        byteLength: sourceBlob.size,
        checksumSha256: "a".repeat(64),
        displayName: "quiet.png",
        height: 1,
        mimeType: "image/png",
        width: 1,
      },
      themeId: "quiet-draft-test",
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    await module.putWebQuickThemeDraft({ draft, sourceBlob });
    const stored = await module.readWebQuickThemeDraft(draft.id);
    const databaseShape = await new Promise<{ legacy: boolean; stores: string[]; version: number }>((resolve, reject) => {
      const request = indexedDB.open("ling-stack-ui2");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("themes", "readonly");
        const get = transaction.objectStore("themes").get("legacy-v2-theme");
        transaction.oncomplete = () => {
          resolve({
            legacy: Boolean(get.result),
            stores: [...database.objectStoreNames].sort(),
            version: database.version,
          });
          database.close();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const mismatchRejected = await module.putWebQuickThemeDraft({ draft })
      .then(() => false, () => true);
    await module.deleteWebQuickThemeDraft(draft.id);
    const removed = await module.readWebQuickThemeDraft(draft.id);
    return {
      databaseShape,
      mismatchRejected,
      removed: removed === undefined,
      stored: stored
        ? { id: stored.id, name: stored.name, sourceBytes: stored.sourceBlob?.size }
        : undefined,
    };

    function readModule(name: string): unknown {
      return (window as unknown as Record<string, unknown>)[name];
    }
  });

  expect(result.databaseShape).toEqual({
    legacy: true,
    stores: ["theme-assets", "theme-draft-assets", "theme-drafts", "theme-packages", "themes"],
    version: 3,
  });
  expect(result.stored).toEqual({ id: "draft-quick-1", name: "Quiet Draft", sourceBytes: 4 });
  expect(result.mismatchRejected).toBe(true);
  expect(result.removed).toBe(true);
});

test("Quick reducer ignores stale analysis and invalidates only dependent results", async ({ page }) => {
  await openSubstratePage(page);
  await exposeModule(page, "__quickThemeState", "/src/features/settings/theme-studio/quick-theme-state.ts");

  const result = await page.evaluate(() => {
    const module = readModule("__quickThemeState") as {
      createQuickThemeState: (input: { draftId: string; themeId: string }) => Record<string, unknown>;
      quickThemeReducer: (state: Record<string, unknown>, action: Record<string, unknown>) => Record<string, unknown>;
    };
    const analysis = {
      width: 1,
      height: 1,
      aspectRatio: 1,
      averageLuminance: 0.7,
      dominantColors: ["#c0c0c0"],
      accentCandidate: "#6080a0",
      leftInformationScore: 0,
      rightInformationScore: 0,
      focusX: 0.5,
      focusY: 0.5,
      safeArea: "center",
      recommendedProfileId: "ling-standard",
    };
    const source = {
      analysis,
      blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
      byteLength: 1,
      checksumSha256: "b".repeat(64),
      displayName: "source.png",
      height: 1,
      mimeType: "image/png",
      width: 1,
    };
    let state = module.createQuickThemeState({ draftId: "draft-1", themeId: "theme-1" });
    state = module.quickThemeReducer(state, { type: "source-started", operationId: 4 });
    const stale = module.quickThemeReducer(state, {
      type: "source-ready",
      operationId: 3,
      source,
      suggestedScheme: "dark",
      suggestedProfileId: "ling-immersive",
    });
    state = module.quickThemeReducer(state, {
      type: "source-ready",
      operationId: 4,
      source,
      suggestedScheme: "light",
      suggestedProfileId: "ling-standard",
    });
    const candidate = {
      readyToPublish: true,
      verification: { blockers: [], warnings: [] },
    };
    state = module.quickThemeReducer(state, { type: "compile-ready", candidate });
    const ready = state;
    state = module.quickThemeReducer(state, { type: "scheme-changed", colorScheme: "dark" });
    const afterScheme = state;
    state = module.quickThemeReducer(state, { type: "source-started", operationId: 5 });
    state = module.quickThemeReducer(state, {
      type: "source-failed",
      operationId: 5,
      issue: { code: "decode-failed", message: "Decode failed." },
    });
    return {
      afterFailure: {
        issueCode: (state.issue as { code?: string } | undefined)?.code,
        sourceName: (state.source as { displayName?: string } | undefined)?.displayName,
        stage: state.stage,
      },
      afterScheme: {
        compiled: afterScheme.compiled !== undefined,
        revision: afterScheme.revision,
        stage: afterScheme.stage,
      },
      ready: {
        compiled: ready.compiled !== undefined,
        revision: ready.revision,
        stage: ready.stage,
      },
      staleIgnored: stale === state || stale.stage === "validating",
    };

    function readModule(name: string): unknown {
      return (window as unknown as Record<string, unknown>)[name];
    }
  });

  expect(result.staleIgnored).toBe(true);
  expect(result.ready).toEqual({ compiled: true, revision: 1, stage: "preview-ready" });
  expect(result.afterScheme).toEqual({ compiled: false, revision: 1, stage: "draft-ready" });
  expect(result.afterFailure).toEqual({
    issueCode: "decode-failed",
    sourceName: "source.png",
    stage: "draft-ready",
  });
});

test("multi-surface preview uses exact scaled desktop geometry and protects Settings and Dialog artwork", async ({ page }, testInfo) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 900, height: 640 });
  await openSubstratePage(page);
  await exposeModule(page, "__quickThemePreviewHarness", "/e2e/support/theme-studio-preview-harness.tsx");

  await mountPreview(page, {
    artwork: true,
    scale: 0.5,
    surface: "home",
    theme: "light",
    viewport: "1280x800",
  });
  const fixture = page.locator("[data-theme-studio-preview-fixture]");
  const previewViewport = fixture.locator(".ling-ui-theme-studio-preview-viewport");
  await expect(fixture).toHaveAttribute("data-preview-viewport", "1280x800");
  await expect(previewViewport.locator("img")).toHaveCount(1);
  const homeGeometry = await previewViewport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return {
      height: rect.height,
      layoutHeight: styles.height,
      layoutWidth: styles.width,
      transform: styles.transform,
      width: rect.width,
    };
  });
  expect(homeGeometry.layoutWidth).toBe("1280px");
  expect(homeGeometry.layoutHeight).toBe("800px");
  expect(homeGeometry.width).toBeCloseTo(640, 1);
  expect(homeGeometry.height).toBeCloseTo(400, 1);
  expect(homeGeometry.transform).toContain("0.5");
  await fixture.getByRole("button", { name: "Start conversation" }).focus();
  await expect(fixture.getByRole("button", { name: "Start conversation" })).toBeFocused();
  await capturePreview(page, testInfo, "home-light-1280x800.png");

  await mountPreview(page, {
    artwork: true,
    scale: 0.4,
    surface: "conversation",
    theme: "dark",
    viewport: "1440x960",
  });
  await expect(fixture).toHaveAttribute("data-preview-surface", "conversation");
  await expect(fixture.getByText("Conversation details")).toBeVisible();
  await expect(fixture.getByText("Workspace terminal")).toBeVisible();
  await fixture.getByRole("button", { name: "Search" }).focus();
  await expect(fixture.getByRole("button", { name: "Search" })).toBeFocused();
  await capturePreview(page, testInfo, "conversation-dark-1440x960.png");

  await mountPreview(page, {
    artwork: true,
    scale: 0.5,
    surface: "settings",
    theme: "dark",
    viewport: "1280x800",
  });
  await expect(previewViewport).toHaveAttribute("data-surface-recipe", "solid");
  await expect(previewViewport).toHaveAttribute("data-artwork", "off");
  await expect(previewViewport.locator("img")).toHaveCount(0);
  await expect(fixture.getByText("Semantic values remain isolated inside this preview.")).toBeVisible();

  await mountPreview(page, {
    artwork: true,
    scale: 0.4,
    surface: "dialog",
    theme: "dark",
    viewport: "1440x960",
  });
  await expect(previewViewport).toHaveAttribute("data-artwork", "off");
  await expect(previewViewport.locator("img")).toHaveCount(0);
  await expect(fixture.getByRole("dialog", { name: "Delete local theme?" })).toBeVisible();
  await expect(fixture.getByRole("status").filter({ hasText: "Theme preview updated" })).toBeVisible();
  await capturePreview(page, testInfo, "dialog-dark-1440x960.png");

  const overflow = await fixture.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
  expect(runtimeErrors).toEqual([]);
});

async function openSubstratePage(page: Page): Promise<void> {
  const uiStylesUrl = `/@fs${fileURLToPath(new URL(
    "../../../packages/ui-react/dist/styles/index.css",
    import.meta.url,
  ))}`;
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:\d+\//u, (socket) => {
    socket.onMessage(() => undefined);
  });
  await page.route("**/__ui2-quick-theme-substrate", async (route) => {
    await route.fulfill({
      body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${uiStylesUrl}"><script>
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script></head><body></body></html>`,
      contentType: "text/html",
      status: 200,
    });
  });
  await page.goto("/__ui2-quick-theme-substrate");
}

async function exposeModule(page: Page, globalName: string, modulePath: string): Promise<void> {
  const errorName = `${globalName}Error`;
  await page.addScriptTag({
    content: `import(${JSON.stringify(modulePath)}).then((moduleValue) => { window[${JSON.stringify(globalName)}] = moduleValue; }).catch((error) => { window[${JSON.stringify(errorName)}] = String(error?.stack ?? error); });`,
    type: "module",
  });
  await expect.poll(() => page.evaluate(({ errorKey, moduleKey }) => {
    const scope = window as unknown as Record<string, unknown>;
    if (scope[errorKey] !== undefined) return `error: ${String(scope[errorKey])}`;
    return scope[moduleKey] !== undefined ? "ready" : "pending";
  }, { errorKey: errorName, moduleKey: globalName })).toBe("ready");
}

async function mountPreview(page: Page, input: {
  readonly artwork: boolean;
  readonly scale: number;
  readonly surface: "conversation" | "dialog" | "home" | "settings";
  readonly theme: "dark" | "light";
  readonly viewport: "1280x800" | "1440x960";
}): Promise<void> {
  await page.evaluate(async (value) => {
    const module = (window as unknown as {
      __quickThemePreviewHarness: {
        mountThemeStudioPreviewHarness: (next: typeof value) => Promise<void>;
      };
    }).__quickThemePreviewHarness;
    await module.mountThemeStudioPreviewHarness(value);
  }, input);
  await expect(page.locator("[data-theme-studio-preview-fixture]")).toHaveAttribute(
    "data-preview-surface",
    input.surface,
  );
}

async function capturePreview(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_SUBSTRATE !== "1") return;
  await page.locator("[data-theme-studio-preview-fixture]").screenshot({
    animations: "disabled",
    path: testInfo.outputPath(filename),
  });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
