const copy = {
  en: {
    title: "Ling for Chrome",
    dataDisclosure: "For browser tasks you approve in Ling, this extension may share HTTP(S) page URLs, visible text, interactive labels, and visible screenshots with your local Ling app.",
    privacy: "Ling does not read Chrome passwords, cookies, history, or bookmarks.",
    checking: ["Checking connection...", "Ling is detecting the local connection component."],
    connected: ["Connected to Ling", "Ling can use this Chrome profile after you approve a browser task."],
    host_missing: ["Connection component needs repair", "Open Ling to install or repair the local connection component."],
    ling_unavailable: ["Ling is not running", "Open Ling, then reconnect this extension."],
    incompatible: ["Update required", "Update Ling and this extension, then reconnect."],
    plugin_disabled: ["Chrome is not enabled", "Enable Chrome in Ling Plugin Manager, then reconnect."],
    paused: ["Paused", "Ling cannot use this Chrome profile until you resume."],
    pause: "Pause",
    resume: "Resume",
    reconnect: "Reconnect",
  },
  zh: {
    title: "Ling 浏览器扩展",
    dataDisclosure: "仅在你批准 Ling 浏览器任务后，此扩展才会与本机 Ling 应用共享 HTTP(S) 页面网址、可见文字、交互元素标签和可见截图。",
    privacy: "Ling 不会读取 Chrome 密码、Cookie、历史记录或书签。",
    checking: ["正在检查连接", "Ling 正在检测本机连接组件。"],
    connected: ["已连接 Ling", "你批准浏览器任务后，Ling 才能使用当前 Chrome。"],
    host_missing: ["连接组件需要修复", "打开 Ling 即可安装或修复本机连接组件。"],
    ling_unavailable: ["Ling 未运行", "请先打开 Ling，再重新连接。"],
    incompatible: ["需要更新", "请更新 Ling 和此扩展，然后重新连接。"],
    plugin_disabled: ["Chrome 未启用", "请先在 Ling 插件管理器中启用 Chrome。"],
    paused: ["已暂停", "恢复前，Ling 无法使用当前 Chrome。"],
    pause: "暂停",
    resume: "恢复",
    reconnect: "重新连接",
  },
};

const locale = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
const t = copy[locale];
for (const element of document.querySelectorAll("[data-i18n]")) {
  element.textContent = t[element.dataset.i18n] ?? element.textContent;
}

const statusElement = document.querySelector("#status");
const descriptionElement = document.querySelector("#description");
const activeTabElement = document.querySelector("#active-tab");
const primaryAction = document.querySelector("#primary-action");
let currentState = "checking";
let actionBusy = false;

primaryAction.addEventListener("click", async () => {
  if (actionBusy) return;
  actionBusy = true;
  render();
  try {
    await chrome.runtime.sendMessage({ type: currentState === "connected" ? "pause" : "resume" });
    await refresh();
  } catch {
    currentState = "ling_unavailable";
    render();
  } finally {
    actionBusy = false;
    render();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "ling.chrome.status_changed") void refresh();
});

async function refresh() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "status" });
    currentState = result?.ok && typeof result.state === "string" ? result.state : "ling_unavailable";
    activeTabElement.textContent = result?.activeTab?.title ?? "";
  } catch {
    currentState = "ling_unavailable";
  }
  render();
}

function render() {
  const stateCopy = t[currentState] ?? t.ling_unavailable;
  statusElement.textContent = stateCopy[0];
  descriptionElement.textContent = stateCopy[1];
  primaryAction.textContent = currentState === "connected" ? t.pause : currentState === "paused" ? t.resume : t.reconnect;
  primaryAction.disabled = actionBusy || currentState === "checking";
  primaryAction.dataset.tone = currentState === "connected" ? "secondary" : "primary";
}

render();
void refresh();
