import { Directory, File, Paths } from "expo-file-system";
import { REMOTE_DEVICE_ARTIFACT_MAX_BYTES, isAndroidApkFileName, isRemoteDeviceArtifactName } from "@ling-stack/contracts";
import { encodeBase64Url, sha256 } from "@ling-stack/remote-protocol";
import { lingDeviceTransport } from "../../modules/ling-device-transport";
import type { OpenPhoneTaskArtifactFile } from "../device/phone-task-artifacts";
import type { AndroidApkSelection } from "../device/usb-android";
import { nativeSecureEntropy } from "./secure-device-key/native-adapter";

export const openPhoneTaskArtifactFile: OpenPhoneTaskArtifactFile = (id, name) => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(id) || !isRemoteDeviceArtifactName(name)) throw new Error("phone_task_artifact_path_invalid");
  const directory = new Directory(Paths.document, "device-artifacts", id);
  const temporary = () => new File(directory, "incoming");
  const verifiedDirectory = new Directory(directory, "verified");
  const verified = () => new File(verifiedDirectory, name);
  const current = () => verified().exists ? verified() : temporary();
  const inspectAndroidApk = lingDeviceTransport?.inspectAndroidApk?.bind(lingDeviceTransport);
  return {
    uri() { return verified().uri; },
    async size() { return current().size; },
    async append(offset, bytes) {
      if (verified().exists) throw new Error("phone_task_artifact_already_verified");
      directory.create({ intermediates: true, idempotent: true });
      const file = temporary();
      if (!file.exists) file.create();
      const handle = file.open();
      try {
        if (handle.size !== offset) throw new Error("phone_task_artifact_offset_changed");
        handle.offset = offset;
        await handle.writeBytes(bytes);
      } finally {
        handle.close();
      }
    },
    async digest() { return `sha256:${await current().digest("SHA-256")}`; },
    ...(inspectAndroidApk ? { inspectAndroidApk: () => inspectAndroidApk(current().uri) } : {}),
    async reset() {
      for (const file of [temporary(), verified()]) {
        if (file.exists) file.delete();
      }
    },
    async seal() {
      if (verified().exists) return;
      verifiedDirectory.create({ intermediates: true, idempotent: true });
      await temporary().move(verified());
    },
    async export() {
      const file = verified();
      if (!file.exists) throw new Error("phone_task_artifact_unverified");
      const destination = await Directory.pickDirectoryAsync();
      await file.copy(destination, { overwrite: false });
    },
  };
};

export async function pickLocalAndroidApk(signal: AbortSignal): Promise<Extract<AndroidApkSelection, { source: "phone_file" }> | undefined> {
  const selected = await File.pickFileAsync({ mimeTypes: ["application/vnd.android.package-archive", "application/octet-stream"] });
  if (selected.canceled || signal.aborted) return undefined;
  const { name, size } = selected.result;
  if (!isRemoteDeviceArtifactName(name) || !isAndroidApkFileName(name) || size <= 0 || size > REMOTE_DEVICE_ARTIFACT_MAX_BYTES) {
    throw new Error("adb_invalid_apk");
  }
  const fileId = encodeBase64Url(sha256(await nativeSecureEntropy.randomBytes(32)));
  const directory = new Directory(Paths.document, "device-artifacts", fileId);
  const artifact = openPhoneTaskArtifactFile(fileId, name);
  directory.create({ intermediates: true, idempotent: false });
  try {
    await selected.result.copy(new File(directory, "incoming"), { overwrite: false });
    signal.throwIfAborted();
    if (await artifact.size() !== size || !artifact.inspectAndroidApk) throw new Error("adb_invalid_apk");
    await artifact.inspectAndroidApk();
    await artifact.seal();
    signal.throwIfAborted();
    return { source: "phone_file", fileId, name };
  } catch (error) {
    directory.delete();
    throw error;
  }
}

export function discardLocalAndroidApk(selection: Extract<AndroidApkSelection, { source: "phone_file" }>): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(selection.fileId)) throw new Error("phone_task_artifact_path_invalid");
  const directory = new Directory(Paths.document, "device-artifacts", selection.fileId);
  if (directory.exists) directory.delete();
}
