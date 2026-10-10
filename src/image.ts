/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：跨 WebView 图片解码、白底灰度量化及无损 4 位 PNG 编码。
 * English: WebView decoding, white-backed grayscale quantization and lossless 4-bit PNG encoding.
 * 冻结：不写原图；不放大；长图不按屏幕高度截断或缩小。
 * Frozen: never write sources, upscale or cap tall images to screen height.
 */
export const IMAGE_WIDTH = 684;
export const IMAGE_HEIGHT = 1216;
export const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
export interface GrayImage { data: Uint8Array; width: number; height: number }
export function imageSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('图片尺寸无效或超过像素上限，未转换。');
  }
  const tall = height / width > IMAGE_HEIGHT / IMAGE_WIDTH;
  const scale = Math.min(1, IMAGE_WIDTH / width, tall ? 1 : IMAGE_HEIGHT / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(new TextEncoder().encode(type), 4); result.set(data, 8);
  view.setUint32(result.length - 4, crc32(result.subarray(4, result.length - 4)));
  return result;
}
// 中文：旧 WebView 仍可输出标准 zlib 无压缩块，不引入 Node 或平台依赖。
// English: older WebViews can emit standard stored zlib blocks without Node or platform dependencies.
function storedZlib(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + Math.ceil(data.length / 65535) * 5 + 6);
  result.set([0x78, 0x01]);
  let output = 2, a = 1, b = 0;
  for (let offset = 0; offset < data.length;) {
    const count = Math.min(65535, data.length - offset);
    result[output++] = offset + count === data.length ? 1 : 0;
    result[output++] = count & 255; result[output++] = count >>> 8;
    result[output++] = (~count) & 255; result[output++] = ((~count) >>> 8) & 255;
    result.set(data.subarray(offset, offset + count), output); output += count; offset += count;
  }
  for (const byte of data) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  new DataView(result.buffer).setUint32(output, ((b << 16) | a) >>> 0);
  return result;
}
export async function encodeGrayPng(rgba: Uint8ClampedArray, width: number, height: number): Promise<GrayImage> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > IMAGE_WIDTH || width * height > MAX_IMAGE_PIXELS || rgba.length !== width * height * 4) {
    throw new Error('图片像素缓冲区无效。');
  }
  const stride = Math.ceil(width / 2) + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const alpha = rgba[index + 3] / 255;
      const luminance = (0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2]) * alpha + 255 * (1 - alpha);
      const gray = Math.max(0, Math.min(15, Math.round(luminance / 17)));
      raw[y * stride + 1 + (x >>> 1)] |= gray << (x % 2 === 0 ? 4 : 0);
    }
  }
  let compressed: Uint8Array;
  if (typeof CompressionStream !== 'undefined') {
    const writer = new Blob([raw.buffer]).stream().pipeThrough(new CompressionStream('deflate'));
    compressed = new Uint8Array(await new Response(writer).arrayBuffer());
  } else compressed = storedZlib(raw);
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height); ihdr[8] = 4;
  return { width, height, data: concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]) };
}
export async function convertImage(source: ArrayBuffer, mime: string): Promise<GrayImage> {
  const blob = new Blob([source], { type: mime });
  let image: ImageBitmap | HTMLImageElement;
  let objectUrl: string | undefined;
  try {
    if (typeof createImageBitmap === 'function') image = await createImageBitmap(blob);
    else {
      objectUrl = URL.createObjectURL(blob);
      const element = new Image();
      await new Promise<void>((resolve, reject) => { element.onload = () => resolve(); element.onerror = () => reject(new Error('图片解码失败。')); element.src = objectUrl!; });
      image = element;
    }
    try {
      const size = imageSize(image.width, image.height);
      const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前 WebView 无法创建图片转换画布。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, size.width, size.height);
      context.drawImage(image, 0, 0, size.width, size.height);
      return await encodeGrayPng(context.getImageData(0, 0, size.width, size.height).data, size.width, size.height);
    } finally { if ('close' in image) image.close(); }
  } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
}
