import type { Locale } from "../i18n.js";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";

export const dictionaries: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};
