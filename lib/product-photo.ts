import { MAX_PRODUCT_IMAGE_LENGTH } from "./shelf";

const SIZE = 256;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * Turns a photo the user picked into a small square JPEG data URL (center crop,
 * 256×256) so it fits comfortably in localStorage. Runs only in the browser;
 * the original file is never stored or uploaded.
 */
export async function photoToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("That image is too large (over 20 MB).");
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot resize images.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, SIZE, SIZE);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
    for (const quality of [0.82, 0.7, 0.55]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_PRODUCT_IMAGE_LENGTH) return url;
    }
    throw new Error("Could not make the photo small enough to save.");
  } finally {
    bitmap.close();
  }
}
