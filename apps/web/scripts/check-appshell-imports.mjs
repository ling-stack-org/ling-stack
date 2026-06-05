import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appShellPath = resolve("src/app/AppShell.tsx");
const source = readFileSync(appShellPath, "utf8");

if (/from\s+["']\.\.\/api\.js["']/.test(source) || /from\s+["']\.\.\/api["']/.test(source)) {
  console.error("AppShell must use domain command controllers instead of importing ../api.js directly.");
  process.exit(1);
}
