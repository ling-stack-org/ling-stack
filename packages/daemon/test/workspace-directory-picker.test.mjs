import assert from "node:assert/strict";
import test from "node:test";
import {
  selectWorkspaceDirectory,
  WorkspaceDirectoryPickerError,
} from "../dist/features/workspace-directory/directory-picker.js";

test("workspace directory picker returns a normalized selected directory", async () => {
  const response = await selectWorkspaceDirectory({
    platform: "darwin",
    defaultPath: "/tmp",
    execFileImpl: async (file, args) => {
      assert.equal(file, "osascript");
      assert.match(args.join("\n"), /choose folder/);
      return { stdout: "/tmp/ling-project/\n", stderr: "" };
    },
    statImpl: async () => ({ isDirectory: () => true }),
  });

  assert.deepEqual(response, {
    cancelled: false,
    path: "/tmp/ling-project",
    label: "ling-project",
  });
});

test("workspace directory picker treats native cancellation as a non-error", async () => {
  const response = await selectWorkspaceDirectory({
    platform: "darwin",
    execFileImpl: async () => {
      const error = new Error("User canceled.");
      error.stderr = "User canceled.";
      throw error;
    },
    statImpl: async () => {
      assert.fail("cancelled selections should not be statted");
    },
  });

  assert.deepEqual(response, { cancelled: true });
});

test("workspace directory picker rejects non-directory selections", async () => {
  await assert.rejects(
    () => selectWorkspaceDirectory({
      platform: "darwin",
      execFileImpl: async () => ({ stdout: "/tmp/file.txt\n", stderr: "" }),
      statImpl: async () => ({ isDirectory: () => false }),
    }),
    (error) => error instanceof WorkspaceDirectoryPickerError
      && error.code === "directory_picker_invalid_selection"
      && error.statusCode === 400,
  );
});

test("workspace directory picker reports unsupported platforms", async () => {
  await assert.rejects(
    () => selectWorkspaceDirectory({
      platform: "freebsd",
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
    }),
    (error) => error instanceof WorkspaceDirectoryPickerError
      && error.code === "directory_picker_unsupported"
      && error.statusCode === 501,
  );
});
