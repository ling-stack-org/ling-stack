import { app, BrowserWindow } from "electron";

const label = process.argv
  .find((argument) => argument.startsWith("--ling-windows-provider-target-label="))
  ?.slice("--ling-windows-provider-target-label=".length)
  .trim();
if (label !== "A" && label !== "B") {
  throw new Error("windows_provider_smoke_target_label_invalid");
}
const READY_MARKER = `Ling Windows provider smoke target ${label} ready`;
const CLOSE_ACCEPTED_MARKER = `Ling Windows provider smoke target ${label} close accepted`;
const CLOSED_MARKER = `Ling Windows provider smoke target ${label} closed`;
let targetWindow;
let closeRequested = false;

app.on("window-all-closed", () => app.quit());

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (
    closeRequested
    || !String(chunk).split(/\r?\n/u).some((line) => line.trim() === "close")
  ) {
    return;
  }
  closeRequested = true;
  console.log(CLOSE_ACCEPTED_MARKER);
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.close();
  } else {
    console.log(CLOSED_MARKER);
    app.quit();
  }
});

await app.whenReady();
targetWindow = new BrowserWindow({
  width: 640,
  height: 400,
  show: true,
  title: `Ling Windows Provider Smoke Target ${label}`,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});
targetWindow.once("closed", () => {
  console.log(CLOSED_MARKER);
});
const html = `<!doctype html><html><head><meta charset="utf-8">` +
  `<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;color:#eef6ff;` +
  `font:600 28px system-ui;background:linear-gradient(135deg,#12233c,#274f88)}div{padding:28px 36px;` +
  `border:1px solid #ffffff55;border-radius:18px;background:#08111fcc}</style></head>` +
  `<body><div>Ling Windows provider smoke target ${label}</div></body></html>`;
await targetWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
console.log(`${READY_MARKER} pid=${process.pid}`);
