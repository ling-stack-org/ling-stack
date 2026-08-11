import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function ensureGitRepoForChannelPost(url, body) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/channels") {
    return;
  }
  const cwd = parsed.searchParams.get("cwd");
  const root = typeof body?.boundPath === "string" && body.boundPath.trim() ? body.boundPath.trim() : cwd;
  if (!root) {
    return;
  }
  await ensureGitRepo(root);
}

export async function ensureGitRepo(cwd) {
  await mkdir(cwd, { recursive: true });
  const existing = await git(cwd, ["rev-parse", "--show-toplevel"]).then(
    () => true,
    () => false,
  );
  if (!existing) {
    await git(cwd, ["init"]);
  }
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Ling Test"]);

  const hasHead = await git(cwd, ["rev-parse", "--verify", "HEAD"]).then(
    () => true,
    () => false,
  );
  if (hasHead) {
    return;
  }

  await writeFile(resolve(cwd, ".gitignore"), ".ling-stack/\n", "utf8");
  await writeFile(resolve(cwd, "README.md"), "test workspace\n", "utf8");
  await git(cwd, ["add", ".gitignore", "README.md"]);
  await git(cwd, ["commit", "-m", "Initial test workspace"]);
}

export async function ensureEmptyGitRepo(cwd) {
  await mkdir(cwd, { recursive: true });
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Ling Test"]);
}

async function git(cwd, args) {
  return await execFileAsync("git", args, { cwd, timeout: 15000, maxBuffer: 1024 * 1024 });
}
