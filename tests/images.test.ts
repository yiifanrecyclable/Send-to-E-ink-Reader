/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：合成图片、Markdown 引用和二进制附件发布回归。
 * English: synthetic image, Markdown reference and binary publication regressions.
 * 冻结：不读取真实笔记、不请求真实云端，不代替手机实机验收。
 * Frozen: no real vault/cloud access; never substitute for mobile acceptance.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { encodeGrayPng, imageSize } from '../src/image';
import { exportImages } from '../src/export-images';
import { publish, type DavBody, type DavResponse, type DavTransport } from '../src/publish';
import { parseManifest, sha256, utf8 } from '../src/protocol';

const cancel = () => ({ requested: false });
const clock = () => new Date('2026-10-05T01:02:03Z');
async function picture(value = 0) {
  const rgba = new Uint8ClampedArray(3 * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = rgba[i + 1] = rgba[i + 2] = value; rgba[i + 3] = 255; }
  return encodeGrayPng(rgba, 3, 1);
}
function pixels(data: Uint8Array): Uint8Array {
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset < data.length;) {
    const length = new DataView(data.buffer, data.byteOffset + offset).getUint32(0);
    const type = new TextDecoder().decode(data.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') idat.push(data.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return inflateSync(Buffer.concat(idat));
}
test('ordinary images fit both dimensions while tall images retain height and never upscale', () => {
  assert.deepEqual(imageSize(1368, 1000), { width: 684, height: 500 });
  assert.deepEqual(imageSize(684, 4000), { width: 684, height: 4000 });
  assert.deepEqual(imageSize(1368, 8000), { width: 684, height: 4000 });
  assert.deepEqual(imageSize(100, 2000), { width: 100, height: 2000 });
  assert.deepEqual(imageSize(200, 100), { width: 200, height: 100 });
  assert.throws(() => imageSize(0, 10)); assert.throws(() => imageSize(684, 100000));
});
test('PNG is grayscale color type zero at four bits, with all sixteen levels and transparent white', async () => {
  const rgba = new Uint8ClampedArray(17 * 4);
  for (let i = 0; i < 16; i++) rgba.set([i * 17, i * 17, i * 17, 255], i * 4);
  const png = await encodeGrayPng(rgba, 17, 1);
  assert.deepEqual([...png.data.subarray(24, 29)], [4, 0, 0, 0, 0]);
  assert.deepEqual([...pixels(png.data)], [0, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xf0]);
  const original = globalThis.CompressionStream;
  try {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: undefined });
    assert.deepEqual([...pixels((await encodeGrayPng(rgba, 17, 1)).data)], [...pixels(png.data)]);
  } finally { Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: original }); }
});
test('standard, wiki, reference, escaped-parenthesis and angle destinations reuse one exported attachment', async () => {
  const original = '![标准](<图 (1).png> "标题")\n![[图 (1).png|200]]\n![引用][图]\n[图]: <图 (1).png>\n![括号](图\\ (1).png)\n![括号](图%20\\(1\\).png)';
  let reads = 0, converts = 0;
  const exported = await exportImages(original, '文章', {
    resolve: target => target === '图 (1).png' ? { key: 'attachments/图 (1).png', mime: 'image/png', read: async () => { reads++; return new ArrayBuffer(1); } } : undefined,
    convert: async () => { converts++; return picture(); }, random: () => '0123456789abcdef'
  });
  assert.equal(reads, 1); assert.equal(converts, 1); assert.equal(exported.assets.length, 1);
  assert.equal(exported.assets[0].name, '文章-0123456789abcdef.png');
  assert.equal(exported.body.split('attachments/%E6%96%87%E7%AB%A0-0123456789abcdef.png').length - 1, 4);
  assert.equal(original.includes('attachments/'), false);
});
test('code and escaped images remain literal while remote and missing images become prose', async () => {
  const source = '`![[a.png]]`\n```md\n![x](a.png)\n```\n    ![[a.png]]\n> ```md\n> ![[a.png]]\n> ```\n\\![[a.png]]\n![网络](https://example.test/a.png)\n![[missing.md]]';
  let resolves = 0;
  const exported = await exportImages(source, '文章', { resolve: () => { resolves++; return undefined; }, convert: async () => picture() });
  assert.equal(exported.body, source.replace('![网络](https://example.test/a.png)', '（图片或嵌入未导出：网络）').replace('![[missing.md]]', '（图片或嵌入未导出：missing.md）'));
  assert.equal(resolves, 1); assert.equal(exported.assets.length, 0);
  assert.ok(exported.warnings.some(w => w.includes('远程'))); assert.ok(exported.warnings.some(w => w.includes('嵌入')));
});

class BinaryDav implements DavTransport {
  files = new Map<string, { body: DavBody; etag: string }>();
  calls: { method: string; path: string; headers: Record<string, string> }[] = [];
  hook?: (method: string, path: string) => void;
  sequence = 0;
  async request(method: string, path: string, body?: DavBody, headers: Record<string, string> = {}): Promise<DavResponse> {
    this.calls.push({ method, path, headers });
    const old = this.files.get(path);
    let response: DavResponse = { status: 201, text: '', headers: {} };
    if (method === 'GET') response = old ? {
      status: 200, text: typeof old.body === 'string' ? old.body : '', bytes: typeof old.body === 'string' ? undefined : old.body, headers: { ETag: old.etag }
    } : { status: 404, text: '', headers: {} };
    if (method === 'PUT') {
      if ((headers['If-None-Match'] === '*' && old) || (headers['If-Match'] && old?.etag !== headers['If-Match'])) response.status = 412;
      else this.files.set(path, { body: body!, etag: `"${++this.sequence}"` });
    }
    this.hook?.(method, path); return response;
  }
}

test('mixed valid, remote, missing, unsupported and failed image references export only good attachments', async () => {
  const source = '![好][local]\n![远程][web]\n![缺失][]\n![svg](bad.svg)\n![读失败](read.png)\n![解码失败](decode.png)\n![未定义][none]\n[local]: good.png\n[web]: https://example.test/a.png\n[缺失]: absent.png\n`![代码](remote.png)`';
  const exported = await exportImages(source, '文章', {
    resolve: target => ['good.png', 'read.png', 'decode.png'].includes(target) ? {
      key: target, mime: 'image/png', read: async () => { if (target === 'read.png') throw new Error('read'); return new Uint8Array([target === 'decode.png' ? 2 : 1]).buffer; }
    } : undefined,
    convert: async data => { if (new Uint8Array(data)[0] === 2) throw new Error('decode'); return picture(); }, random: () => '0123456789abcdef'
  });
  assert.equal(exported.assets.length, 1);
  assert.ok(exported.body.startsWith('![好](attachments/'));
  for (const label of ['远程', '缺失', 'svg', '读失败', '解码失败', '未定义']) assert.ok(exported.body.includes(`（图片或嵌入未导出：${label}）`));
  assert.ok(exported.body.endsWith('`![代码](remote.png)`'));
  assert.ok(exported.warnings.some(w => w.includes('读取或转换失败')));
  const published = await publish(new BinaryDav(), { namespace: 'fake', vaultPath: '文章.md', title: exported.title, body: exported.body, assets: exported.assets }, cancel(), undefined, clock);
  assert.equal(published.manifest.assets.length, 1);
});
test('shortcut and collapsed references share valid assets; malformed and HTML images become safe literal text', async () => {
  const exported = await exportImages('![好][]\n![好]\n[好]: good.png\n![坏](a b.png)\n<img src="https://example.test/x.png">\n![未闭合', '文章', {
    resolve: target => target === 'good.png' ? { key: target, mime: 'image/png', read: async () => new ArrayBuffer(1) } : undefined,
    convert: async () => picture(), random: () => '0123456789abcdef'
  });
  assert.equal(exported.assets.length, 1);
  assert.equal(exported.body.split('![好](attachments/').length - 1, 2);
  assert.ok(exported.body.includes('（图片或嵌入未导出：坏）'));
  assert.ok(!exported.body.includes('<img'));
  assert.ok(exported.body.endsWith('\\!\\[未闭合'));
  assert.ok(exported.warnings.length > 0);
});
test('unsupported image labels cannot inject Markdown and cancellation is never treated as degradation', async () => {
  const exported = await exportImages('![嵌套![恶意](x.png)](missing.png)', '文章', { resolve: () => undefined, convert: async () => picture() });
  assert.ok(exported.body.includes('\\!\\[恶意\\]\\(x.png\\)'));
  let cancelled = false;
  await assert.rejects(exportImages('![图](x.png)', '文章', {
    resolve: () => ({ key: 'x', mime: 'image/png', read: async () => new ArrayBuffer(1) }),
    convert: async () => { cancelled = true; throw new Error('cancelled'); }, cancelled: () => cancelled
  }), /取消/);
});
async function publication(value = 0, suffix = '0123456789abcdef') {
  const asset = { ...(await picture(value)), name: `文章-${suffix}.png` };
  return { namespace: 'shared', vaultPath: '目录/文章.md', title: '文章', body: `![图](attachments/${encodeURIComponent(asset.name)})`, assets: [asset] };
}
test('v2 publishes checked immutable PNG before the conditional manifest; duplicate names across folders replace one article', async () => {
  const dav = new BinaryDav(), input = await publication();
  const first = await publish(dav, input, cancel(), undefined, clock);
  const { manifest } = first;
  assert.equal(manifest.schema_version, 2); assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.body.sha256, await sha256(utf8(input.body)));
  assert.equal(manifest.assets[0].sha256, await sha256(input.assets[0].data));
  assert.ok(dav.calls.findIndex(c => c.method === 'GET' && c.path.endsWith('.png')) < dav.calls.findIndex(c => c.method === 'PUT' && c.path.endsWith('.json')));
  const second = await publish(dav, { ...input, vaultPath: '其他目录/文章.md', body: input.body + '\n新版' }, cancel(), undefined, clock);
  assert.equal(second.manifest.article_id, manifest.article_id);
  assert.ok(dav.calls.filter(c => c.method === 'PUT' && c.path.endsWith('.json')).at(-1)?.headers['If-Match']);
});
test('same body and images reuse names and preserve revision with no writes, but image-only changes create a revision', async () => {
  const dav = new BinaryDav();
  const first = await publish(dav, await publication(), cancel(), undefined, clock);
  dav.calls = [];
  const same = await publish(dav, await publication(0, 'fedcba9876543210'), cancel(), undefined, () => new Date('2026-10-06T00:00:00Z'));
  assert.equal(same.unchanged, true); assert.deepEqual(same.manifest, first.manifest);
  assert.equal(dav.calls.some(c => c.method !== 'GET'), false);
  const changed = await publish(dav, await publication(255), cancel(), undefined, clock);
  assert.equal(changed.manifest.body.sha256, first.manifest.body.sha256);
  assert.notEqual(changed.manifest.revision_id, first.manifest.revision_id);
});
test('corrupt binary readback and cancellation before attachment commit preserve prior manifest', async () => {
  for (const corruption of [false, true]) {
    const dav = new BinaryDav(), cancellation = cancel();
    const first = await publish(dav, await publication(), cancel(), undefined, clock);
    dav.hook = (method, path) => {
      if (method === 'PUT' && path.endsWith('.png')) {
        if (corruption) dav.files.get(path)!.body = new ArrayBuffer(80);
        else cancellation.requested = true;
      }
    };
    await assert.rejects(publish(dav, await publication(255), cancellation, undefined, clock), /附件不匹配|取消/);
    assert.equal(JSON.parse(dav.files.get(`${first.manifest.article_id}.pico.json`)!.body as string).revision_id, first.manifest.revision_id);
  }
});
test('v2 rejects foreign owned paths, duplicate assets, invalid PNG type and forged dimensions before publishing', async () => {
  const input = await publication(), first = await publish(new BinaryDav(), input, cancel(), undefined, clock);
  for (const assets of [
    [{ ...first.manifest.assets[0], path: '../outside.png' }],
    [first.manifest.assets[0], first.manifest.assets[0]],
    [{ ...first.manifest.assets[0], width: 685 }],
    [{ ...first.manifest.assets[0], bytes: -1 }]
  ]) assert.throws(() => parseManifest(JSON.stringify({ ...first.manifest, assets }), first.manifest.article_id));
  const bad = new Uint8Array(input.assets[0].data); bad[25] = 2;
  const dav = new BinaryDav();
  await assert.rejects(publish(dav, { ...input, assets: [{ ...input.assets[0], data: bad }] }, cancel()), /4 位灰度/);
  assert.equal(dav.calls.length, 0);
});


test('original-image fingerprints preserve published encoding across different WebView deflate output', async () => {
  const dav = new BinaryDav(), firstInput = await publication();
  const sourceHash = await sha256(new Uint8Array([1, 2, 3]));
  const first = await publish(dav, { ...firstInput, assets: [{ ...firstInput.assets[0], source_sha256: sourceHash }] }, cancel(), undefined, clock);
  const original = globalThis.CompressionStream;
  let stored;
  try {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: undefined });
    stored = await picture();
  } finally { Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: original }); }
  assert.notDeepEqual(stored.data, firstInput.assets[0].data);
  const secondInput = await publication(0, 'fedcba9876543210');
  dav.calls = [];
  const same = await publish(dav, { ...secondInput, assets: [{ ...secondInput.assets[0], ...stored, source_sha256: sourceHash }] }, cancel(), undefined, clock);
  assert.equal(same.unchanged, true); assert.deepEqual(same.manifest, first.manifest);
  assert.equal(dav.calls.some(c => c.method !== 'GET'), false);
  const sourceChanged = await publish(dav, { ...firstInput, assets: [{ ...firstInput.assets[0], source_sha256: '0'.repeat(64) }] }, cancel(), undefined, clock);
  assert.notEqual(sourceChanged.manifest.revision_id, first.manifest.revision_id);
});


test('v2 interchange fixture matches exact body and grayscale PNG bytes', async () => {
  const expected = JSON.parse(await readFile('tests/fixtures/sample-image-manifest.json', 'utf8'));
  const body = await readFile('tests/fixtures/sample-image-body.md', 'utf8');
  const data = new Uint8Array(await readFile('tests/fixtures/sample-image.png'));
  const published = await publish(new BinaryDav(), {
    namespace: 'pico-example-vault', vaultPath: '阅读/Pico 图片样例.md', title: 'Pico 图片样例', body,
    assets: [{ name: expected.assets[0].path.split('/').at(-1), width: 16, height: 16, data }]
  }, cancel(), undefined, clock);
  assert.deepEqual(published.manifest, expected);
});

test('degraded interchange fixture preserves a valid image and code with exact body and manifest hashes', async () => {
  const source = await readFile('tests/fixtures/sample-degraded-source.md', 'utf8');
  const expectedBody = await readFile('tests/fixtures/sample-degraded-body.md', 'utf8');
  const expected = JSON.parse(await readFile('tests/fixtures/sample-degraded-manifest.json', 'utf8'));
  const png = new Uint8Array(await readFile('tests/fixtures/sample-image.png'));
  const exported = await exportImages(source, 'Pico 降级样例', {
    resolve: target => target === 'sample-image.png' ? { key: target, mime: 'image/png', read: async () => png.buffer } : undefined,
    convert: async () => ({ data: png, width: 16, height: 16 }), random: () => '0123456789abcdef'
  });
  assert.equal(exported.body, expectedBody); assert.equal(exported.assets.length, 1);
  assert.equal(exported.warnings.length, 3);
  const result = await publish(new BinaryDav(), { namespace: 'pico-example-vault', vaultPath: '阅读/Pico 降级样例.md',
    title: exported.title, body: exported.body, assets: exported.assets }, cancel(), undefined, clock);
  assert.deepEqual(result.manifest, expected);
});

test('legacy v2 filename metadata migration preserves body and asset revision', async () => {
  const dav = new BinaryDav(), input = await publication();
  const first = await publish(dav, input, cancel(), undefined, clock);
  const path = `${first.manifest.article_id}.pico.json`;
  const legacy = { ...first.manifest }; delete legacy.source_filename;
  dav.files.get(path)!.body = JSON.stringify(legacy);
  const migrated = await publish(dav, input, cancel(), undefined, clock);
  assert.equal(migrated.manifest.source_filename, '文章.md');
  assert.equal(migrated.manifest.revision_id, first.manifest.revision_id);
  assert.deepEqual(migrated.manifest.body, first.manifest.body);
  assert.deepEqual(migrated.manifest.assets, first.manifest.assets);
});
