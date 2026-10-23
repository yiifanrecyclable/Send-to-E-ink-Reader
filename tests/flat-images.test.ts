/* SPDX-License-Identifier: Apache-2.0
 * 中文：扁平图文、设备参数和本地导出的隔离回归。
 * English: isolated flat-image, device-profile and local-export regressions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { deviceProfile, PICO_PROFILE } from '../src/device-profile';
import { imageSize, encodeGrayPng, sourceImageSize } from '../src/image';
import { exportImages } from '../src/export-images';
import { exportText } from '../src/export-text';
import { publishFlat } from '../src/flat-publish';
import { exportLocal, LOCAL_EXPORT_ROOT, type ExportStorage } from '../src/local-export';
import { sha256, utf8 } from '../src/protocol';
import type { DavTransport, DavBody, DavResponse } from '../src/publish';

const picture = async (value = 0) => encodeGrayPng(new Uint8ClampedArray([value, value, value, 255, 255, 255, 255, 255]), 2, 1);
const note = (source = '段落\n\n![图片](图.png)', value = 0) => exportImages(source, '测试', {
  resolve: () => ({ key: '图.png', mime: 'image/png', read: async () => new Uint8Array([value]).buffer }),
  convert: () => picture(value)
});
class Dav implements DavTransport {
  files = new Map<string, DavBody>(); calls: { method: string; path: string }[] = [];
  failImage = false; cancelOnImage?: { requested: boolean };
  async request(method: string, path: string, body?: DavBody, headers: Record<string, string> = {}): Promise<DavResponse> {
    this.calls.push({ method, path });
    if (method === 'MKCOL') return { status: 201, text: '', headers: {} };
    if (method === 'PUT') {
      if (path.endsWith('.png') && this.failImage) throw new Error('network');
      if (this.files.has(path) && headers['If-None-Match'] === '*') return { status: 412, text: '', headers: {} };
      this.files.set(path, body!);
      if (path.endsWith('.png') && this.cancelOnImage) this.cancelOnImage.requested = true;
      return { status: 201, text: '', headers: {} };
    }
    const old = this.files.get(path);
    return old === undefined ? { status: 404, text: '', headers: {} } :
      { status: 200, text: typeof old === 'string' ? old : '', bytes: typeof old === 'string' ? undefined : old, headers: {} };
  }
}
test('default profile and custom resolution/grayscale retain no account fields and reject invalid values', () => {
  assert.deepEqual(deviceProfile(), PICO_PROFILE);
  assert.deepEqual(deviceProfile({ width: 1404, height: 1872, grayLevels: 4 }), { width: 1404, height: 1872, grayLevels: 4 });
  for (const bad of [{ width: 0 }, { height: NaN }, { grayLevels: 1 }, { grayLevels: 257 }, { width: 1024.5 }]) assert.throws(() => deviceProfile(bad));
  assert.deepEqual(imageSize(2808, 2000, { width: 1404, height: 1872, grayLevels: 4 }), { width: 1404, height: 1000 });
  assert.throws(() => imageSize(684, 9000), /长/);
});
test('PNG bit packing supports user grayscale values, including non-power-of-two counts', async () => {
  const rgba = new Uint8ClampedArray(256 * 4);
  for (let x = 0; x < 256; x++) rgba.set([x, x, x, 255], x * 4);
  for (const levels of [2, 4, 8, 16, 32, 256, 5]) {
    const png = (await encodeGrayPng(rgba, 256, 1, { width: 684, height: 1216, grayLevels: levels })).data;
    const bits = png[24]; assert.equal(bits, levels === 2 ? 1 : levels === 4 ? 2 : levels === 16 ? 4 : 8);
    const length = new DataView(png.buffer, png.byteOffset + 33).getUint32(0);
    const raw = inflateSync(png.subarray(41, 41 + length));
    const values = new Set<number>();
    for (let x = 0; x < 256; x++) values.add((raw[1 + ((x * bits) >>> 3)] >> (8 - bits - (x * bits) % 8)) & ((1 << bits) - 1));
    assert.equal(values.size, levels);
  }
});
test('source header checks reject pixel bombs before the browser decoder', async () => {
  const p = await picture();
  assert.deepEqual(sourceImageSize(new Uint8Array(p.data).buffer, 'image/png'), { width: 2, height: 1 });
  const bomb = new Uint8Array(p.data);new DataView(bomb.buffer).setUint32(16, 0x7fffffff);
  assert.throws(() => sourceImageSize(bomb.buffer, 'image/png'));
  assert.throws(() => sourceImageSize(new ArrayBuffer(1), 'image/jpeg'));
  const jpeg = new Uint8Array([255,216,255,192,0,8,8,0,120,0,200,1,255,217]);
  assert.deepEqual(sourceImageSize(jpeg.buffer, 'image/jpeg'), { width: 200, height: 120 });
});
test('image-free Markdown remains byte-identical to the original text exporter with no attachment access', async () => {
  const sources = ['# 标题\n\n正文 **粗体** *斜体* ==高亮==\n', '|A|B|\n|---|---|\n|1|2|',
    '`![代码](x.png)`\n```md\n![[示例.png]]\n```', '[[链接|显示]]\n\n- a\n- b\n> 引用', '---\ntitle: test\n---\n## 正文\n'];
  for (const source of sources) {
    const a = exportText(source, '测试');
    const b = await exportImages(source, '测试', { resolve: () => { throw new Error('must not read'); }, convert: () => { throw new Error('must not decode'); } });
    assert.equal(b.body, a.body); assert.deepEqual(b.warnings, a.warnings); assert.equal(b.assets.length, 0);
    const dav = new Dav(); await publishFlat(dav, { vaultPath: '测试.md', body: b.body, assets: b.assets }, { requested: false });
    assert.deepEqual(dav.calls.map(c => c.method), ['GET', 'PUT', 'GET']);
  }
});
test('flat publication verifies attachments first, repeats without rewriting, and changes image identity', async () => {
  const dav = new Dav(), first = await note();
  assert.equal(first.assets[0].name, `测试-${(await sha256(first.assets[0].data)).slice(0, 16)}.png`);
  await publishFlat(dav, { vaultPath: '测试.md', ...first }, { requested: false });
  const writes = dav.calls.filter(c => c.method === 'PUT'); assert.ok(writes[0].path.startsWith('attachments/')); assert.equal(writes.at(-1)?.path, '测试.md');
  const again = await note(); assert.equal(again.body, first.body);
  dav.calls = []; const result = await publishFlat(dav, { vaultPath: '测试.md', ...again }, { requested: false });
  assert.equal(result.unchanged, true); assert.equal(dav.calls.filter(c => c.method === 'PUT').length, 0);
  const changed = await note(undefined, 255); assert.notEqual(changed.assets[0].name, first.assets[0].name);
  await publishFlat(dav, { vaultPath: '测试.md', ...changed }, { requested: false });
  assert.equal(dav.files.get('测试.md'), changed.body); assert.equal(dav.files.size, 3);
  assert.ok([...dav.files.keys()].every(p => p === '测试.md' || p.startsWith('attachments/')));
});
test('long Unicode titles and parentheses produce bounded unambiguous device image references', async () => {
  for (const title of ['中文'.repeat(100), "(未闭合'!*"]) {
    const exported = await exportImages('![图](图.png)', title, {
      resolve: () => ({ key: '图.png', mime: 'image/png', read: async () => new ArrayBuffer(1) }), convert: () => picture()
    });
    const reference = exported.body.slice(exported.body.indexOf('](') + 2, -1);
    assert.ok(reference.length <= 240); assert.ok(!/[()'!*]/.test(reference));
    assert.equal(decodeURIComponent(reference), 'attachments/' + exported.assets[0].name);
  }
});
test('table images downgrade explicitly without reading files or changing text table structure', async () => {
  const source = '| 项目 | 图片 |\n| --- | --- |\n| 正文 | ![图](图.png) |';
  const result = await exportImages(source, '测试', { resolve: () => { throw new Error('must not read'); }, convert: () => picture() });
  assert.equal(result.assets.length, 0); assert.ok(result.warnings.some(w => w.includes('表格内图片')));
  assert.ok(result.body.startsWith('| 项目 | 图片 |\n| --- | --- |\n| 正文 |'));
});
test('attachment failures, conflicts and cancellation preserve the previous text', async () => {
  for (const mode of ['failure', 'conflict', 'cancel']) {
    const dav = new Dav(), exported = await note(), cancel = { requested: false };
    dav.files.set('测试.md', '旧正文');
    if (mode === 'failure') dav.failImage = true;
    if (mode === 'conflict') dav.files.set('attachments/' + exported.assets[0].name, utf8('different').buffer as ArrayBuffer);
    if (mode === 'cancel') dav.cancelOnImage = cancel;
    await assert.rejects(publishFlat(dav, { vaultPath: '测试.md', ...exported }, cancel));
    assert.equal(dav.files.get('测试.md'), '旧正文'); assert.ok(!dav.calls.some(c => c.method === 'PUT' && c.path === '测试.md'));
  }
});
class Local implements ExportStorage {
  files = new Map<string, ArrayBuffer>(); dirs = new Set<string>(); failCommit = false;
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async mkdir(p: string) { this.dirs.add(p); }
  async readBinary(p: string) { if (!this.files.has(p)) throw new Error('missing'); return this.files.get(p)!; }
  async writeBinary(p: string, data: ArrayBuffer) { this.files.set(p, data); }
  async write(p: string, text: string) { this.files.set(p, new Uint8Array(utf8(text)).buffer); }
  async rename(a: string, b: string) {
    if (this.failCommit && a.endsWith('.part')) throw new Error('EIO');
    if (this.files.has(b)) throw new Error('FAT overwrite');
    this.files.set(b, await this.readBinary(a)); this.files.delete(a);
  }
  async remove(p: string) { this.files.delete(p); }
}
test('local export matches cloud layout, never writes sources, and restores old text after commit failure', async () => {
  const storage = new Local(), exported = await note();
  await storage.write('源/测试.md', '原笔记');
  const target = await exportLocal(storage, '源/测试.md', exported);
  assert.equal(target, LOCAL_EXPORT_ROOT + '/测试.md');
  assert.equal(new TextDecoder().decode(await storage.readBinary('源/测试.md')), '原笔记');
  assert.equal(new TextDecoder().decode(await storage.readBinary(target)), exported.body);
  await assert.rejects(exportLocal(storage, target, exported));
  storage.failCommit = true;
  await assert.rejects(exportLocal(storage, '源/测试.md', { ...exported, body: '新版' }));
  assert.equal(new TextDecoder().decode(await storage.readBinary(target)), exported.body);
});
