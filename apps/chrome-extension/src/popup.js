const copy = {
  en: {
    title: "Ling for Chrome",
    workspace: "Workspace path",
    pairingCode: "Pairing code",
    connect: "Connect",
    disconnect: "Disconnect this extension",
    dataDisclosure: "For browser tasks you approve in Ling, this extension may share HTTP(S) page URLs, visible text, interactive labels, and visible screenshots with your local Ling app.",
    privacy: "Ling does not read Chrome passwords, cookies, history, or bookmarks.",
    consent: "I understand and agree to connect this Chrome profile to my local Ling workspace.",
    connected: "Connected to Ling",
    paired: "Waiting for Ling",
    disconnected: "Not connected",
    checking: "Checking connection...",
  },
  zh: {
    title: "Ling 浏览器扩展",
    workspace: "工作区路径",
    pairingCode: "配对码",
    connect: "连接",
    disconnect: "断开此扩展",
    dataDisclosure: "仅在你批准 Ling 浏览器任务后，此扩展才会与本机 Ling 应用共享 HTTP(S) 页面网址、可见文字、交互元素标签和可见截图。",
    privacy: "Ling 不会读取 Chrome 密码、Cookie、历史记录或书签。",
    consent: "我了解并同意将此 Chrome 配置连接到本机 Ling 工作区。",
    connected: "已连接 Ling",
    paired: "正在等待 Ling",
    disconnected: "尚未连接",
    checking: "正在检查连接...",
  },
};

const locale = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
const t = copy[locale];
for (const element of document.querySelectorAll("[data-i18n]")) {
  element.textContent = t[element.dataset.i18n] ?? element.textContent;
}

const statusElement = document.querySelector("#status");
const pairingSection = document.querySelector("#pairing");
const connectedSection = document.querySelector("#connected");
const cwdInput = document.querySelector("#cwd");
const codeInput = document.querySelector("#pairing-code");
const consentInput = document.querySelector("#consent");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const activeTabElement = document.querySelector("#active-tab");
let pairingBusy = false;
let refreshBusy = false;

connectButton.addEventListener("click", async () => {
  if (!consentInput.checked || pairingBusy) return;
  pairingBusy = true;
  syncConnectAvailability();
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "pair",
      cwd: cwdInput.value,
      pairingCode: codeInput.value,
    });
  } catch {
    pairingBusy = false;
    statusElement.textContent = t.disconnected;
    syncConnectAvailability();
    return;
  }
  if (!result?.ok) {
    pairingBusy = false;
    statusElement.textContent = result?.error ?? t.disconnected;
    syncConnectAvailability();
  } else {
    pairingBusy = false;
    consentInput.checked = false;
    await refresh();
  }
});

disconnectButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  consentInput.checked = false;
  await refresh();
});

for (const control of [cwdInput, codeInput, consentInput]) {
  control.addEventListener("input", syncConnectAvailability);
  control.addEventListener("change", syncConnectAvailability);
}

async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "status" });
    if (!result?.ok) {
      statusElement.textContent = result?.error ?? t.disconnected;
      return;
    }
    cwdInput.value = result.cwd ?? cwdInput.value;
    pairingSection.hidden = result.paired;
    connectedSection.hidden = !result.paired;
    if (result.paired) codeInput.value = "";
    statusElement.textContent = result.connected ? t.connected : result.paired ? t.paired : t.disconnected;
    activeTabElement.textContent = result.activeTab?.title ?? "";
    syncConnectAvailability();
  } catch {
    statusElement.textContent = t.disconnected;
  } finally {
    refreshBusy = false;
  }
}

function syncConnectAvailability() {
  connectButton.disabled = pairingBusy || !consentInput.checked || !cwdInput.value.trim() || !codeInput.value.trim();
}

statusElement.textContent = t.checking;
syncConnectAvailability();
void refresh();
window.setInterval(() => void refresh(), 1_000);
