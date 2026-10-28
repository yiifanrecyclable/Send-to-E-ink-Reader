/*
 * SPDX-License-Identifier: Apache-2.0
 * 中文：真实WebP样本的头解析、解码前边界与PNG导出回归。
 * English: real WebP fixtures, predecode bounds and PNG export regressions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { sourceImageMime, sourceImageSize, convertImage } from '../src/image';
import { exportImages } from '../src/export-images';

async function fixture(name: string): Promise<ArrayBuffer> {
  return Uint8Array.from(await readFile(new URL(`fixtures/webp-${name}.webp`, import.meta.url))).buffer;
}
test('WebP extension mapping and three real still container formats', async () => {
  for (const ext of ['webp', 'WEBP', 'WebP']) assert.equal(sourceImageMime(ext), 'image/webp');
  assert.equal(sourceImageMime('svg'), undefined);
  assert.equal(sourceImageMime('constructor'), undefined);
  for (const kind of ['lossy', 'lossless', 'alpha'])
    assert.deepEqual(sourceImageSize(await fixture(kind), 'image/webp'), { width: 3, height: 1 });
});
test('animation, truncation, bad RIFF/chunk lengths and oversized canvas fail before decoding', async () => {
  assert.throws(() => sourceImageSize(new ArrayBuffer(2), 'image/webp'));
  assert.throws(() => sourceImageSize(new Uint8Array([1, 2]).buffer, 'image/png'));
  assert.throws(() => sourceImageSize(new ArrayBuffer(20), 'image/webp'));
  const animation = await fixture('animated');
  assert.throws(() => sourceImageSize(animation, 'image/webp'), /动画/);
  await assert.rejects(convertImage(animation, 'image/webp'), /动画/);
  const original = await fixture('alpha');
  assert.throws(() => sourceImageSize(original.slice(0, -1), 'image/webp'));
  const chunk = original.slice(0);new DataView(chunk).setUint32(16, 0xffffffff, true);
  assert.throws(() => sourceImageSize(chunk, 'image/webp'));
  const bomb = await fixture('lossless');
  new DataView(bomb).setUint32(21, (16383 | (16383 << 14)) >>> 0, true);
  assert.throws(() => sourceImageSize(bomb, 'image/webp'), /像素上限/);
  const mismatch = original.slice(0);new Uint8Array(mismatch)[24] = 5;
  assert.throws(() => sourceImageSize(mismatch, 'image/webp'));
});
test('failed WebP decode degrades with a warning while source and ordinary text stay intact', async () => {
  const source = '正文\n![[图.webp]]';
  const bytes = await fixture('animated'), before = bytes.slice(0);
  const result = await exportImages(source, '测试', {
    resolve: () => ({ key: '图.webp', mime: 'image/webp', read: async () => bytes }), convert: convertImage
  });
  assert.equal(result.assets.length, 0);assert.ok(result.warnings.length);
  assert.ok(result.body.startsWith('正文\n'));assert.deepEqual(bytes, before);
  assert.equal((await exportImages('纯文本', '测试', { resolve: () => { throw Error('unused'); }, convert: convertImage })).body, '纯文本');
});
