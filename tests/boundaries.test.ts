/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：独立复审发现的内容保真及协议边界回归。
 * English: regressions for fidelity and protocol boundaries found in independent review.
 * 冻结：只读取合成样例，不接触真实 vault 或云账户。
 * Frozen: synthetic fixtures only; no real vault or cloud account access.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { preprocess } from '../src/preprocess';
import { articleId, normalizedPath, parseManifest, MAX_BODY_BYTES } from '../src/protocol';

test('empty frontmatter is removed and later thematic blocks are never mistaken for frontmatter', () => {
  assert.equal(preprocess('---\n---\n正文', '标题').body, '正文');
  assert.equal(preprocess('--- \n... \n正文', '标题').body, '正文');
  const source = '正文\n---\n后面的内容\n---\n尾部';
  assert.equal(preprocess(source, '标题').body, source);
});

test('empty and multiline YAML title do not consume the next property as a title', () => {
  for (const value of ['', '|', '>']) {
    const result = preprocess(`---\ntitle: ${value}\ntags: [正文]\n---\n正文`, '回退标题');
    assert.equal(result.title, '回退标题');
    assert.equal(result.body, '正文');
  }
  assert.equal(preprocess("---\ntitle: 'Don''t edit'\n---\n正文", '文件名').title, "Don't edit");
});

test('multiline inline code preserves wiki links, images and nonmatching backtick runs', () => {
  const source = '文本 ``第一行\n[[代码链接]] ` ![[code.png]]\n末行`` [[笔记|可读]]';
  const result = preprocess(source, '标题');
  assert.equal(result.body, '文本 ``第一行\n[[代码链接]] ` ![[code.png]]\n末行`` 可读');
  assert.equal(result.warnings.length, 0);
});

test('escaped delimiters and blank paragraphs cannot hide ordinary wiki transformations', () => {
  assert.equal(preprocess('\\`[[笔记|可读]]`', '标题').body, '\\`可读`');
  assert.equal(preprocess('`开始\n\n[[笔记|可读]]\n结束`', '标题').body, '`开始\n\n可读\n结束`');
  assert.equal(preprocess('`未闭合 [[笔记|可读]]', '标题').body, '`未闭合 可读');
});

test('quoted indented and unclosed fenced code remain literal', () => {
  for (const source of ['>     [[代码]] ![[图.png]]', '>\t[[代码]]', '~~~md\n[[代码]]\n正文']) {
    const result = preprocess(source, '标题');
    assert.equal(result.body, source); assert.equal(result.warnings.length, 0);
  }
});

test('BOM and CRLF normalize once and a shortcut image receives a visible warning', () => {
  const result = preprocess('\uFEFF---\r\ntitle: 标题\r\n---\r\n正文\r\n![图片]', '文件名');
  assert.equal(result.title, '标题'); assert.equal(result.body, '正文\n![图片]');
  assert.ok(result.warnings.some(w => w.includes('图片')));
});

test('namespace and source path NFC identity is stable with exact UTF-8 boundary validation', async () => {
  assert.equal(await articleId('café', '目录/café.md'), await articleId('cafe\u0301', '目录/cafe\u0301.md'));
  assert.equal(normalizedPath('中'.repeat(80)), '中'.repeat(80));
  assert.throws(() => normalizedPath('中'.repeat(80) + 'a'));
  assert.match(await articleId('a'.repeat(128), 'note.md'), /^[a-f0-9]{64}$/);
  await assert.rejects(articleId('a'.repeat(129), 'note.md'));
});

test('interchange fixture table defines accepted metadata and refuses malformed resource descriptors', async () => {
  const base = JSON.parse(await readFile('tests/fixtures/sample-manifest.json', 'utf8'));
  const cases: { name: string; valid: boolean; overrides?: Record<string, unknown>; body_overrides?: Record<string, unknown> }[] =
    JSON.parse(await readFile('tests/fixtures/manifest-cases.json', 'utf8'));
  for (const item of cases) {
    const candidate = { ...base, ...item.overrides, body: { ...base.body, ...item.body_overrides } };
    if (item.valid) assert.equal(parseManifest(JSON.stringify(candidate), base.article_id).article_id, base.article_id, item.name);
    else assert.throws(() => parseManifest(JSON.stringify(candidate), base.article_id), item.name);
  }
  for (const key of Object.keys(base)) {
    if (key === 'source_filename') continue;
    const candidate = { ...base }; delete candidate[key];
    assert.throws(() => parseManifest(JSON.stringify(candidate), base.article_id), `missing ${key}`);
  }
  assert.throws(() => parseManifest(' '.repeat(4097), base.article_id));
  assert.throws(() => parseManifest(JSON.stringify(base), '0'.repeat(64)));
  assert.equal(parseManifest(JSON.stringify({ ...base, body: { ...base.body, bytes: MAX_BODY_BYTES } }), base.article_id).body.bytes, MAX_BODY_BYTES);
});

test('v1 and v2 accept missing source filename without substituting title, but reject malformed basename metadata', async () => {
  for (const file of ['sample-manifest.json', 'sample-image-manifest.json']) {
    const base = JSON.parse(await readFile(`tests/fixtures/${file}`, 'utf8'));
    const legacy = { ...base }; delete legacy.source_filename;
    const parsed = parseManifest(JSON.stringify(legacy), base.article_id);
    assert.equal(Object.hasOwn(parsed, 'source_filename'), false);
    assert.equal(parsed.title, base.title);
    const exact = { ...base, source_filename: 'a'.repeat(237) + '.md' };
    assert.equal(parseManifest(JSON.stringify(exact), base.article_id).source_filename, exact.source_filename);
    for (const source_filename of [null, 123, '', '.md', 'file.txt', '/file.md', 'dir/file.md', 'dir\\file.md',
      'file\0.md', 'file\n.md', 'file\x7f.md', 'cafe\u0301.md', 'a'.repeat(238) + '.md', '中'.repeat(80) + '.md']) {
      assert.throws(() => parseManifest(JSON.stringify({ ...base, source_filename }), base.article_id));
    }
  }
});
