import { Directory, File, Paths } from "expo-file-system";
import { isRemoteDeviceArtifactName } from "@ling-stack/contracts";
import type { OpenPhoneTaskArtifactFile } from "../device/phone-task-artifacts";

export const openPhoneTaskArtifactFile: OpenPhoneTaskArtifactFile = (id, name) => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(id) || !isRemoteDeviceArtifactName(name)) throw new Error("phone_task_artifact_path_invalid");
  const directory = new Directory(Paths.document, "device-artifacts", id);
  const temporary = () => new File(directory, "incoming");
  const verifiedDirectory = new Directory(directory, "verified");
  const verified = () => new File(verifiedDirectory, name);
  const current = () => verified().exists ? verified() : temporary();
  return {
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
