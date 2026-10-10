/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：协议和发布失败边界的宿主测试。
 * English: host tests for protocol and publication failure boundaries.
 * 冻结：仅用内存传输，不连接真实账户。
 * Frozen: use in-memory transport only; never connect to real accounts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { articleId, encodePath, MAX_BODY_BYTES, parseManifest, utf8 } from '../src/protocol';
import { preprocess } from '../src/preprocess';
import { publish, conditionalEtag, PublishError, type Cancellation, type DavResponse, type DavTransport } from '../src/publish';

const clock = () => new Date('2026-10-05T01:02:03.000Z');
const input = { namespace: 'shared-vault', vaultPath: '笔记/文章.md', title: '文章', body: '# 中文\n正文\n' };
interface Call { method: string; path: string; body?: string; headers: Record<string, string> }
// 中文：模拟条件写，能注入上传/发布后的失败。/ English: model conditional writes and inject failures after upload/publication.
class MemoryDav implements DavTransport {
  files = new Map<string, { text: string; etag: string }>();
  calls: Call[] = [];
  hook?: (call: Call, response: DavResponse) => void | Promise<void>;
  sequence = 0;
  async request(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<DavResponse> {
    const call = { method, path, body, headers }; this.calls.push(call);
    const old = this.files.get(path);
    let response: DavResponse;
    if (method === 'GET') response = old ? { status: 200, text: old.text, headers: { ETag: old.etag } } : { status: 404, text: '', headers: {} };
    else if (method === 'MKCOL') response = { status: 201, text: '', headers: {} };
    else if (method === 'PUT') {
      if ((headers['If-None-Match'] === '*' && old) || (headers['If-Match'] && headers['If-Match'] !== old?.etag)) {
        response = { status: 412, text: '', headers: {} };
      } else {
        this.files.set(path, { text: body ?? '', etag: `"v${++this.sequence}"` });
        response = { status: old ? 204 : 201, text: '', headers: {} };
      }
    } else throw new Error('Unexpected method');
    await this.hook?.(call, response);
    return response;
  }
}
const cancelled = (): Cancellation => ({ requested: false });

test('successful PUT with missing or altered stored body never publishes a manifest', async () => {
  for (const failure of ['missing', 'corrupt', 'wrong-raw-bytes']) {
    const dav = new MemoryDav();
    dav.hook = (call, response) => {
      if (call.method === 'PUT' && call.path.endsWith('body.md')) {
        if (failure === 'missing') dav.files.delete(call.path);
        if (failure === 'corrupt') dav.files.get(call.path)!.text = '正文没有保存完整';
      }
      if (failure === 'wrong-raw-bytes' && call.method === 'GET' && call.path.endsWith('body.md')) response.bytes = new Uint8Array([1, 2, 3]).buffer;
    };
    await assert.rejects(publish(dav, input, cancelled(), undefined, clock), /校验上传正文失败|正文回读不匹配/);
    assert.equal(dav.calls.filter(c => c.method === 'PUT' && c.path.endsWith('.json')).length, 0);
  }
});
test('new body byte verification finishes before stable manifest publication', async () => {
  const dav = new MemoryDav();
  await publish(dav, input, cancelled(), undefined, clock);
  const bodyRead = dav.calls.findIndex(c => c.method === 'GET' && c.path.endsWith('body.md'));
  const commit = dav.calls.findIndex(c => c.method === 'PUT' && c.path.endsWith('.json'));
  assert.ok(bodyRead >= 0 && bodyRead < commit);
});

test('conditional tokens preserve quotes, normalize safe bare tokens and reject unsafe validators', () => {
  assert.equal(conditionalEtag('"version-1"'), '"version-1"');
  assert.equal(conditionalEtag('version:1.2'), '"version:1.2"');
  for (const value of [undefined, '', 'W/"weak"', '*', 'one,two', 'bad\r\nInjected: x', 'x'.repeat(129)]) assert.equal(conditionalEtag(value), undefined);
});

class BareDav extends MemoryDav {
  override async request(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<DavResponse> {
    const response = await super.request(method, path, body, headers);
    if (response.headers.ETag) response.headers.ETag = response.headers.ETag.replace(/^"|"$/g, '');
    return response;
  }
}
test('bare GET versions support a second update using a quoted conditional write', async () => {
  const dav = new BareDav();
  const first = await publish(dav, input, cancelled(), undefined, clock);
  const second = await publish(dav, { ...input, body: '第二版' }, cancelled(), undefined, clock);
  assert.equal(second.manifest.article_id, first.manifest.article_id);
  assert.notEqual(second.manifest.revision_id, first.manifest.revision_id);
  assert.match(dav.calls.filter(c => c.method === 'PUT' && c.path.endsWith('.json')).at(-1)!.headers['If-Match'], /^"v\d+"$/);
});
test('no-op verifies resources and rereads the manifest with bare, absent or weak validators', async () => {
  for (const validator of ['bare-version', '', 'W/"weak"']) {
    const dav = new MemoryDav(), first = await publish(dav, input, cancelled(), undefined, clock);
    const path = `${first.manifest.article_id}.pico.json`;
    dav.files.get(path)!.etag = validator; dav.calls = [];
    assert.equal((await publish(dav, input, cancelled(), undefined, clock)).unchanged, true);
    assert.ok(dav.calls.every(c => c.method === 'GET'));
    assert.equal(dav.calls.at(-1)!.path, path);
  }
});
test('unsafe update validators stop before any write and no-op detects a concurrent manifest change', async () => {
  for (const validator of ['', 'W/"weak"', 'bad\r\nheader', 'one,two', '*']) {
    const dav = new MemoryDav(), first = await publish(dav, input, cancelled(), undefined, clock);
    dav.files.get(`${first.manifest.article_id}.pico.json`)!.etag = validator; dav.calls = [];
    await assert.rejects(publish(dav, { ...input, body: '新版' }, cancelled(), undefined, clock), /条件更新标记/);
    assert.ok(dav.calls.every(c => c.method === 'GET'));
  }
  const dav = new MemoryDav(), first = await publish(dav, input, cancelled(), undefined, clock);
  const path = `${first.manifest.article_id}.pico.json`;
  dav.hook = call => { if (call.method === 'GET' && call.path === first.manifest.body.path) {
    const file = dav.files.get(path)!; file.text = JSON.stringify({ ...first.manifest, title: '另一端标题' });
  } };
  await assert.rejects(publish(dav, input, cancelled(), undefined, clock), /另一端更新/);
});
test('bare-version conflicts and unsupported conditionals never fall back to unconditional writes', async () => {
  class RejectDav extends BareDav {
    status = 0;
    override async request(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<DavResponse> {
      if (this.status && method === 'PUT' && path.endsWith('.json') && headers['If-Match']) {
        this.calls.push({ method, path, body, headers }); return { status: this.status, text: '', headers: {} };
      }
      return super.request(method, path, body, headers);
    }
  }
  for (const status of [400, 405, 501]) {
    const dav = new RejectDav(), first = await publish(dav, input, cancelled(), undefined, clock);
    const path = `${first.manifest.article_id}.pico.json`; dav.calls = [];
    dav.status = status;
    await assert.rejects(publish(dav, { ...input, body: '新版' }, cancelled(), undefined, clock), /另一端更新|未接受条件更新/);
    const commits = dav.calls.filter(c => c.method === 'PUT' && c.path === path);
    assert.equal(commits.length, 1); assert.ok(commits[0].headers['If-Match']);
    assert.equal(JSON.parse(dav.files.get(path)!.text).revision_id, first.manifest.revision_id);
  }
  const dav = new BareDav(), first = await publish(dav, input, cancelled(), undefined, clock);
  const path = `${first.manifest.article_id}.pico.json`;
  dav.hook = call => { if (call.method === 'PUT' && call.path.endsWith('body.md')) dav.files.get(path)!.etag = '"another-writer"'; };
  await assert.rejects(publish(dav, { ...input, body: '并发新版' }, cancelled(), undefined, clock), /另一端更新/);
  assert.equal(JSON.parse(dav.files.get(path)!.text).revision_id, first.manifest.revision_id);
});

test('firmware interchange fixture matches the exact text publisher protocol', async () => {
  const body = await readFile('tests/fixtures/sample-body.md', 'utf8');
  const expected = JSON.parse(await readFile('tests/fixtures/sample-manifest.json', 'utf8'));
  const result = await publish(new MemoryDav(), {
    namespace: 'pico-example-vault', vaultPath: '阅读/Pico 文本样例.md', title: 'Pico 文本样例', body
  }, cancelled(), undefined, clock);
  assert.deepEqual(result.manifest, expected);
});

test('shared namespace/filename identity merges duplicate names and changes on rename', async () => {
  const id = await articleId('shared-vault', 'one/文章.md');
  assert.equal(id, await articleId(' shared-vault ', 'one/文章.md'));
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, await articleId('shared-vault', 'two/文章.md'));
  assert.notEqual(id, await articleId('shared-vault', 'one/新名.md'));
  assert.notEqual(id, await articleId('other-vault', 'one/文章.md'));
});

test('paths encode segments once and reject traversal, controls and UTF-8 overflow', async () => {
  assert.equal(encodePath('标题 #/% &.md'), '%E6%A0%87%E9%A2%98%20%23/%25%20%26.md');
  for (const path of ['../note.md', 'x/../note.md', '/note.md', 'x\\note.md', 'x//note.md', 'a\0.md', '中'.repeat(81)]) {
    assert.throws(() => encodePath(path));
  }
  await assert.rejects(articleId('', 'note.md'));
});

test('frontmatter and wikilinks normalize while fenced, indented and inline code remain literal', () => {
  const source = '---\ntitle: "阅读标题"\ntags: [x]\n---\n[[笔记|别名]] [[笔记#段落]]\n`[[行内]]`\n````js\n[[代码]] ![[图.png]]\n```\n[[仍在代码]]\n````\n    [[缩进代码]]\n\\[[转义]]';
  const result = preprocess(source, '文件名');
  assert.equal(result.title, '阅读标题');
  assert.match(result.body, /^别名 笔记 · 段落/);
  assert.match(result.body, /`\[\[行内\]\]`/);
  assert.match(result.body, /\[\[仍在代码\]\]/);
  assert.match(result.body, /    \[\[缩进代码\]\]/);
  assert.match(result.body, /\\\[\[转义\]\]/);
  assert.equal(result.warnings.length, 0);
});

test('unsupported images, embeds and dynamic blocks require visible warnings and are preserved', () => {
  const result = preprocess('![[image.png]]\n![图](image.png)\n```dataview\nLIST\n```\n`= this.title`', '标题');
  assert.ok(result.warnings.length >= 3);
  assert.ok(result.body.includes('![[image.png]]'));
  assert.ok(result.body.includes('LIST'));
  assert.ok(result.body.includes('`= this.title`'));
});

test('quoted and list-contained code fences keep wiki syntax unchanged', () => {
  const source = '> ```md\n> [[引用代码]]\n> ```\n- ```\n  [[列表代码]]\n  ```\n[[正文|转换]]';
  const result = preprocess(source, '标题');
  assert.ok(result.body.includes('> [[引用代码]]'));
  assert.ok(result.body.includes('  [[列表代码]]'));
  assert.ok(result.body.endsWith('转换'));
});

test('publication orders immutable body before conditional manifest and confirms by GET', async () => {
  const dav = new MemoryDav();
  const { manifest } = await publish(dav, input, cancelled(), undefined, clock);
  assert.equal(manifest.body.bytes, utf8(input.body).length);
  assert.equal(manifest.revision_id, manifest.body.sha256);
  assert.deepEqual(manifest.assets, []);
  const writes = dav.calls.filter(c => c.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path, manifest.body.path);
  assert.equal(writes[0].headers['If-None-Match'], '*');
  assert.equal(writes[1].path, `${manifest.article_id}.pico.json`);
  assert.equal(writes[1].headers['If-None-Match'], '*');
  assert.equal(dav.calls.at(-1)?.method, 'GET');
});

test('same-article updates preserve creation time and protect replacement with strong ETag', async () => {
  const dav = new MemoryDav();
  const first = await publish(dav, input, cancelled(), undefined, clock);
  const second = await publish(dav, { ...input, body: '新版正文' }, cancelled(), undefined,
    () => new Date('2026-10-06T01:02:03.000Z'));
  assert.equal(first.manifest.article_id, second.manifest.article_id);
  assert.notEqual(first.manifest.revision_id, second.manifest.revision_id);
  assert.equal(first.manifest.created_at, second.manifest.created_at);
  assert.ok(dav.files.has(first.manifest.body.path));
  assert.ok(dav.calls.filter(c => c.method === 'PUT' && c.path.endsWith('.pico.json')).at(-1)?.headers['If-Match']);
});

test('oversized UTF-8 body fails before any request', async () => {
  const dav = new MemoryDav();
  await assert.rejects(publish(dav, { ...input, body: '中'.repeat(Math.ceil(MAX_BODY_BYTES / 3)) }, cancelled()), /256 KiB/);
  assert.equal(dav.calls.length, 0);
});

test('NUL and lone UTF-16 surrogates are rejected before any network request', async () => {
  for (const body of ['before\0after', '\ud800', '\udc00', '\ud800\ud800', '正文\ud800']) {
    const dav = new MemoryDav();
    await assert.rejects(publish(dav, { ...input, body }, cancelled()), /NUL|代理项/);
    assert.equal(dav.calls.length, 0);
  }
  for (const change of [{ namespace: 'vault\ud800' }, { vaultPath: '目录/\udc00.md' }, { title: '标题\ud800' }]) {
    const dav = new MemoryDav();
    await assert.rejects(publish(dav, { ...input, ...change }, cancelled()), /代理项/);
    assert.equal(dav.calls.length, 0);
  }
});

test('valid emoji surrogate pairs preserve exact UTF-8 bytes', async () => {
  const body = '中文😀\n';
  const dav = new MemoryDav();
  const result = await publish(dav, { ...input, body }, cancelled(), undefined, clock);
  assert.equal(result.manifest.body.bytes, 11);
  assert.equal(dav.files.get(result.manifest.body.path)?.text, body);
});

test('corrupt prior manifest and weak ETag stop before writing', async () => {
  const dav = new MemoryDav();
  const first = await publish(dav, input, cancelled(), undefined, clock);
  const path = `${first.manifest.article_id}.pico.json`;
  dav.files.get(path)!.etag = 'W/"weak"'; dav.calls = [];
  await assert.rejects(publish(dav, { ...input, body: '新版正文' }, cancelled()), /条件更新标记/);
  assert.equal(dav.calls.length, 1);
  dav.files.get(path)!.text = '{"schema_version":1}';
  await assert.rejects(publish(dav, input, cancelled()), /清单/);
  assert.equal(dav.calls.filter(c => c.method === 'PUT').length, 0);
});

test('manifest validator refuses forged body paths, checksum and attachments', async () => {
  const first = await publish(new MemoryDav(), input, cancelled(), undefined, clock);
  for (const mutated of [
    { ...first.manifest, body: { ...first.manifest.body, path: '../body.md' } },
    { ...first.manifest, body: { ...first.manifest.body, sha256: '0'.repeat(64) } },
    { ...first.manifest, assets: [{ path: 'image.png' }] },
    { ...first.manifest, created_at: '2026-02-30T01:02:03.000Z' }
  ]) assert.throws(() => parseManifest(JSON.stringify(mutated), first.manifest.article_id));
});

test('cancellation after body prevents publication and preserves prior article', async () => {
  const dav = new MemoryDav();
  const first = await publish(dav, input, cancelled(), undefined, clock);
  const cancel = cancelled();
  dav.hook = call => { if (call.method === 'PUT' && call.path.endsWith('body.md')) cancel.requested = true; };
  await assert.rejects(publish(dav, { ...input, body: '新版' }, cancel, undefined, clock),
    error => error instanceof PublishError && error.outcome === 'cancelled');
  assert.equal(JSON.parse(dav.files.get(`${first.manifest.article_id}.pico.json`)!.text).revision_id, first.manifest.revision_id);
});

test('cancellation while manifest is in flight still confirms committed publication', async () => {
  const dav = new MemoryDav(); const cancel = cancelled();
  dav.hook = call => { if (call.method === 'PUT' && call.path.endsWith('.pico.json')) cancel.requested = true; };
  const result = await publish(dav, input, cancel, undefined, clock);
  assert.equal(result.cancelRequested, true);
  assert.equal(dav.calls.at(-1)?.method, 'GET');
});

test('lost commit response is resolved by readback; lost readback reports uncertain outcome', async () => {
  const dav = new MemoryDav();
  dav.hook = call => { if (call.method === 'PUT' && call.path.endsWith('.pico.json')) throw new Error('connection lost'); };
  assert.ok((await publish(dav, input, cancelled(), undefined, clock)).manifest);
  const broken = new MemoryDav();
  let committed = false;
  broken.hook = call => {
    if (call.method === 'PUT' && call.path.endsWith('.pico.json')) committed = true;
    if (call.method === 'GET' && committed) throw new Error('offline');
  };
  await assert.rejects(publish(broken, input, cancelled(), undefined, clock),
    error => error instanceof PublishError && error.outcome === 'uncertain');
});

test('concurrent publication fails conditional write and does not replace the winning version', async () => {
  const dav = new MemoryDav();
  const first = await publish(dav, input, cancelled(), undefined, clock);
  const path = `${first.manifest.article_id}.pico.json`;
  dav.hook = call => {
    if (call.method === 'PUT' && call.path.endsWith('body.md')) dav.files.get(path)!.etag = '"other-writer"';
  };
  await assert.rejects(publish(dav, { ...input, body: '新版' }, cancelled(), undefined, clock), /另一端更新/);
  assert.equal(JSON.parse(dav.files.get(path)!.text).revision_id, first.manifest.revision_id);
});

test('reusing a content revision verifies an immutable body rather than overwriting it', async () => {
  const dav = new MemoryDav();
  const first = await publish(dav, input, cancelled(), undefined, clock);
  dav.files.get(first.manifest.body.path)!.text = 'corrupt';
  await assert.rejects(publish(dav, input, cancelled(), undefined, clock), /不可变版本正文不匹配/);
});

test('publisher records the NFC source filename independently from frontmatter display title', async () => {
  const result = await publish(new MemoryDav(), {
    ...input, vaultPath: '笔记/cafe\u0301.md', title: 'frontmatter 显示标题'
  }, cancelled(), undefined, clock);
  assert.equal(result.manifest.source_filename, 'café.md');
  assert.equal(result.manifest.title, 'frontmatter 显示标题');
  assert.equal(result.manifest.article_id, await articleId(input.namespace, '其他目录/café.md'));
});

test('republishing a legacy filename-less manifest adds metadata without changing the content revision', async () => {
  const dav = new MemoryDav();
  const first = await publish(dav, input, cancelled(), undefined, clock);
  const path = `${first.manifest.article_id}.pico.json`;
  const legacy = { ...first.manifest }; delete legacy.source_filename;
  dav.files.get(path)!.text = JSON.stringify(legacy); dav.calls = [];
  const migrated = await publish(dav, input, cancelled(), undefined, () => new Date('2026-10-06T01:02:03Z'));
  assert.equal(migrated.manifest.source_filename, '文章.md');
  assert.equal(migrated.manifest.revision_id, first.manifest.revision_id);
  assert.equal(migrated.manifest.created_at, first.manifest.created_at);
  assert.ok(dav.calls.find(c => c.method === 'PUT' && c.path === path)?.headers['If-Match']);
  dav.calls = [];
  assert.equal((await publish(dav, input, cancelled(), undefined, () => new Date('2026-10-07T01:02:03Z'))).unchanged, true);
  assert.equal(dav.calls.some(c => c.method !== 'GET'), false);
});
