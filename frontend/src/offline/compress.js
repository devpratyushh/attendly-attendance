export async function compressCapture(source) {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : null;
  const image = bitmap || source;
  const width = image.videoWidth || image.width;
  const height = image.videoHeight || image.height;
  if (!width || !height) throw new Error('The camera is still starting. Try again in a moment.');
  const scale = Math.min(1, 2560 / Math.max(width, height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  bitmap?.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
  if (!blob) throw new Error('The image could not be captured. Please retake.');
  return blob;
}
