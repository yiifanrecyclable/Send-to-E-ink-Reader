/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：跨 WebView 图片解码、白底灰度量化及无损 4 位 PNG 编码。
 * English: WebView decoding, white-backed device grayscale quantization and lossless PNG encoding.
 * 冻结：不写原图；不放大；长图不按屏幕高度截断或缩小。
 * Frozen: never write sources, upscale or cap tall images to screen height.
 */
import { deviceProfile, PICO_PROFILE, EXPORT_IMAGE_PIXELS, EXPORT_IMAGE_HEIGHT, type DeviceProfile } from './device-profile';
export const IMAGE_WIDTH = PICO_PROFILE.width;
export const IMAGE_HEIGHT = PICO_PROFILE.height;
export const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
export interface GrayImage { data: Uint8Array; width: number; height: number }
// 浏览器解码前读取尺寸，拒绝压缩很小但解码后极大的源图。
// Inspect dimensions before browser decoding to reject small compressed pixel bombs.
export function sourceImageSize(source: ArrayBuffer, mime: string): { width: number; height: number } {
  const data = new Uint8Array(source), view = new DataView(source);
  let width = 0, height = 0;
  if (mime === 'image/png' && data.length >= 33 && data.subarray(0, 8).join(',') === '137,80,78,71,13,10,26,10' &&
      view.getUint32(8) === 13 && data.subarray(12, 16).join(',') === '73,72,68,82') {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (mime === 'image/jpeg' && data[0] === 255 && data[1] === 216) {
    for (let offset = 2; offset + 4 <= data.length;) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > data.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > data.length) break;
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('图片尺寸无效或超过像素上限，未转换。');
  return { width, height };
}
export function imageSize(width: number, height: number, options: DeviceProfile = PICO_PROFILE): { width: number; height: number } {
  const profile = deviceProfile(options);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('图片尺寸无效或超过像素上限，未转换。');
  }
  const tall = height / width > profile.height / profile.width;
  const scale = Math.min(1, profile.width / width, tall ? 1 : profile.height / height);
  const output = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  if (output.width * output.height > EXPORT_IMAGE_PIXELS || output.height > EXPORT_IMAGE_HEIGHT)
    throw new Error('图片过长或像素过多，请拆分长图。');
  return output;
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
export async function encodeGrayPng(rgba: Uint8ClampedArray, width: number, height: number, options: DeviceProfile = PICO_PROFILE): Promise<GrayImage> {
  const profile = deviceProfile(options);
  const bits = profile.grayLevels === 2 ? 1 : profile.grayLevels === 4 ? 2 : profile.grayLevels === 16 ? 4 : 8;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > profile.width || height > EXPORT_IMAGE_HEIGHT || width * height > EXPORT_IMAGE_PIXELS || rgba.length !== width * height * 4) {
    throw new Error('图片像素缓冲区无效。');
  }
  const stride = Math.ceil(width * bits / 8) + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const alpha = rgba[index + 3] / 255;
      const luminance = (0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2]) * alpha + 255 * (1 - alpha);
      const level = Math.max(0, Math.min(profile.grayLevels - 1, Math.round(luminance * (profile.grayLevels - 1) / 255)));
      const gray = Math.round(level * ((1 << bits) - 1) / (profile.grayLevels - 1));
      const bit = x * bits;
      raw[y * stride + 1 + (bit >>> 3)] |= gray << (8 - bits - bit % 8);
    }
  }
  let compressed: Uint8Array;
  if (typeof CompressionStream !== 'undefined') {
    const writer = new Blob([raw.buffer]).stream().pipeThrough(new CompressionStream('deflate'));
    compressed = new Uint8Array(await new Response(writer).arrayBuffer());
  } else compressed = storedZlib(raw);
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height); ihdr[8] = bits;
  return { width, height, data: concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]) };
}
export async function convertImage(source: ArrayBuffer, mime: string, options: DeviceProfile = PICO_PROFILE): Promise<GrayImage> {
  const profile = deviceProfile(options);
  if (!['image/png', 'image/jpeg'].includes(mime) || source.byteLength > 32 * 1024 * 1024)
    throw new Error('仅支持32MiB以内的PNG或JPEG源图片。');
  const dimensions = sourceImageSize(source, mime);
  // 解码前也检查导出尺寸，过长图不进入大画布分配。
  // Reject oversized exports before allocating a browser canvas.
  imageSize(dimensions.width, dimensions.height, profile);
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
      const size = imageSize(image.width, image.height, profile);
      const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前 WebView 无法创建图片转换画布。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, size.width, size.height);
      context.drawImage(image, 0, 0, size.width, size.height);
      return await encodeGrayPng(context.getImageData(0, 0, size.width, size.height).data, size.width, size.height, profile);
    } finally { if ('close' in image) image.close(); }
  } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
}
