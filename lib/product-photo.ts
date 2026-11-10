import { MAX_PRODUCT_IMAGE_LENGTH } from "./shelf";

const SIZE = 256;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * Turns a photo the user picked into a small square JPEG data URL (whole photo
 * fitted into 256×256 on white) so it fits comfortably in localStorage. Runs only in the browser;
 * the original file is never stored or uploaded.
 */
export async function photoToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("That image is too large (over 20 MB).");
  const bitmap = await createImageBitmap(file);
  try {
    // Fit the whole photo inside the square (tall bottles keep their cap and label), padded with white.
    const scale = Math.min(SIZE / bitmap.width, SIZE / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot resize images.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, SIZE, SIZE);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, (SIZE - width) / 2, (SIZE - height) / 2, width, height);
    for (const quality of [0.82, 0.7, 0.55]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_PRODUCT_IMAGE_LENGTH) return url;
    }
    throw new Error("Could not make the photo small enough to save.");
  } finally {
    bitmap.close();
  }
}
