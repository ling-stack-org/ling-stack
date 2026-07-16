import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(dirname(harnessDirectory));
const previewIndexPath = join(
  desktopRoot,
  "dist",
  "renderer",
  "computer-use-preview",
  "index.html",
);

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.setName("Ling Computer Use Preview Renderer Harness");
app.on("window-all-closed", () => app.quit());

let previewWindow;

void app.whenReady().then(async () => {
  previewWindow = new BrowserWindow({
    width: 420,
    height: 263,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(harnessDirectory, "preload.cjs"),
    },
  });
  await previewWindow.loadFile(previewIndexPath);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
