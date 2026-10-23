import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { inspectLocalFile, LOCAL_FILE_TEXT_LIMIT } from "../dist/main/local-files/preview.js";
import { registerLocalFileIpc } from "../dist/main/local-files/ipc.js";
import { createLocalFileCapabilities } from "../dist/shared/local-file-activation.js";
import { DESKTOP_LOCAL_FILE_IPC_CHANNELS as channels } from "../dist/shared/ipc-channels.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-local-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("local viewing supports named UTF-8 files, file URLs, relative paths and line anchors", async (t) => {
  const root = await fixture(t);
  const path = join(root, "中文 文件 #1.py");
  await writeFile(path, "print('你好')\n");
  const preview = await inspectLocalFile({ path: pathToFileURL(path).href, line: 2 });
  assert.equal(preview.path, path);
  assert.equal(preview.kind, "text");
  assert.equal(preview.language, "python");
  assert.equal(preview.line, 2);
  assert.equal(preview.text, "print('你好')\n");
  assert.equal((await inspectLocalFile({ path: "中文 文件 #1.py", cwd: root })).text, preview.text);
});

test("unknown binary, archives, invalid UTF-8 and oversized images stay unsupported", async (t) => {
  const root = await fixture(t);
  for (const [name, bytes] of [["archive.zip", "PK archive"], ["binary.dat", Buffer.from([0, 1, 2])], ["legacy.txt", Buffer.from([0xff, 0xfe])], ["large.png", Buffer.alloc(10 * 1024 * 1024 + 1)]]) {
    const path = join(root, name);
    await writeFile(path, bytes);
    const result = await inspectLocalFile({ path });
    assert.equal(result.kind, "unsupported", name);
    assert.equal(result.text, undefined);
  }
});

test("text preview is bounded without splitting a UTF-8 tail, and raster images use data URLs", async (t) => {
  const root = await fixture(t);
  const path = join(root, "large.txt");
  await writeFile(path, "a".repeat(LOCAL_FILE_TEXT_LIMIT - 1) + "你好");
  const preview = await inspectLocalFile({ path });
  assert.equal(preview.kind, "text");
  assert.equal(preview.truncated, true);
  assert.equal(preview.text.length, LOCAL_FILE_TEXT_LIMIT - 1);
  const png = join(root, "image.png");
  await writeFile(png, Buffer.from("iVBORw0KGgo=", "base64"));
  assert.equal((await inspectLocalFile({ path: png })).imageUrl, "data:image/png;base64,iVBORw0KGgo=");
});

test("directory preview sorts folders first, follows explicitly selected links and bounds listing", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "z-folder"));
  await writeFile(join(root, "a.txt"), "hello");
  await symlink(join(root, "a.txt"), join(root, "link.txt"));
  const preview = await inspectLocalFile({ path: root });
  assert.equal(preview.kind, "directory");
  assert.deepEqual(preview.entries.map((entry) => entry.name), ["z-folder", "a.txt", "link.txt"]);
  assert.equal((await inspectLocalFile({ path: join(root, "link.txt") })).text, "hello");
  await Promise.all(Array.from({ length: 510 }, (_, i) => writeFile(join(root, `${i}.txt`), "")));
  const bounded = await inspectLocalFile({ path: root });
  assert.equal(bounded.entries.length, 500);
  assert.equal(bounded.truncated, true);
});

test("network paths, URLs, devices and missing files are not read as ordinary local text", async () => {
  for (const path of ["https://example.com/file.txt", "//server/share/file", "\\\\server\\share", "bad\0path", "relative.txt"]) await assert.rejects(inspectLocalFile({ path }));
  for (const cwd of ["\\\\server\\share", "//server/share"]) await assert.rejects(inspectLocalFile({ path: "report.txt", cwd }), /local_file_invalid_path/u);
  await assert.rejects(inspectLocalFile({ path: "/definitely-not-a-ling-file" }));
  if (process.platform !== "win32") await assert.rejects(inspectLocalFile({ path: "/dev/null" }), /local_file_not_regular/u);
});

test("preload requires a fresh, trusted, matching one-use user gesture", async () => {
  const listeners = new Map();
  const calls = [];
  const api = createLocalFileCapabilities(async (channel, request) => { calls.push({ channel, request }); return {}; }, { addEventListener: (name, listener) => listeners.set(name, listener) });
  const request = { path: "/tmp/test.py", cwd: "/tmp" };
  const activate = (isTrusted = true, path = request.path) => listeners.get("click")({ isTrusted, target: { closest: () => ({ dataset: { localFilePath: path, localFileCwd: "/tmp" } }) } });
  await assert.rejects(api.inspect(request), /user_activation_required/u);
  activate(false);
  await assert.rejects(api.inspect(request), /user_activation_required/u);
  activate(true, "/tmp/other.py");
  await assert.rejects(api.inspect(request), /user_activation_required/u);
  activate();
  await api.inspect(request);
  await assert.rejects(api.inspect(request), /user_activation_required/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, channels.inspect);
  activate();
  await api.showMenu(request);
  assert.equal(calls[1].channel, channels.menu);
});

test("local file IPC accepts only the current packaged main frame and removes handlers", async (t) => {
  const root = await fixture(t);
  const path = join(root, "file.txt");
  await writeFile(path, "visible");
  const handlers = new Map();
  const url = "file:///app/index.html";
  const frame = { url, detached: false };
  const owner = { id: 1, isDestroyed: () => false, mainFrame: frame, getURL: () => url };
  const window = { isDestroyed: () => false, webContents: owner };
  const dispose = registerLocalFileIpc({ ipcMainImpl: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) }, getMainWindow: () => window, trustedDocumentUrl: url });
  const invoke = handlers.get(channels.inspect);
  assert.equal((await invoke({ sender: owner, senderFrame: frame }, { path })).text, "visible");
  await assert.rejects(invoke({ sender: { ...owner, id: 2 }, senderFrame: frame }, { path }), /forbidden/u);
  await assert.rejects(invoke({ sender: owner, senderFrame: { ...frame } }, { path }), /forbidden/u);
  frame.detached = true;
  await assert.rejects(invoke({ sender: owner, senderFrame: frame }, { path }), /forbidden/u);
  dispose();
  assert.equal(handlers.size, 0);
});
