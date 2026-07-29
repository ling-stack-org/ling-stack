export function readImageFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The image could not be read."));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("The image could not be read.")));
    reader.readAsDataURL(file);
  });
}

export function imageDataUrlToFile(dataUrl: string, originalName: string): File {
  const separator = dataUrl.indexOf(",");
  if (separator <= 0) throw new Error("The cropped image could not be read.");
  const header = dataUrl.slice(0, separator);
  const payload = dataUrl.slice(separator + 1);
  const mimeType = /^data:([^;,]+);base64$/u.exec(header)?.[1];
  if (!mimeType?.startsWith("image/")) throw new Error("The cropped image is not an image file.");

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  const stem = originalName.replace(/\.[^.]+$/u, "").trim() || "avatar";
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
  return new File([bytes], `${stem}.${extension}`, { type: mimeType });
}
