/* SPDX-License-Identifier: Apache-2.0
 * 中文：收件路径编码和旧URL识别，只用假路径，不连接云端。
 * English: check folder encoding and legacy URLs without cloud access.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SCOPE, endpointFolder, folderEndpoint, inboxReceipt } from '../src/inbox-settings';
import { articleId } from '../src/protocol';

test('delivery receipt names the actual nested inbox and protocol files without leaking credentials', () => {
  const id = 'a'.repeat(64), body = `_pico/${id}/${'b'.repeat(64)}/body.md`;
  const receipt = inboxReceipt(folderEndpoint('阅读/PicoBox'), id, body);
  assert.ok(receipt.includes('坚果云：阅读/PicoBox/'));
  assert.ok(receipt.includes(`${id}.pico.json`)); assert.ok(receipt.includes(body));
  assert.ok(receipt.includes('不会生成原名 .md'));
  const custom = inboxReceipt('https://user:secret@dav.example.test/box/?secret=hidden', id, body);
  assert.ok(custom.includes('https://dav.example.test/box/'));
  assert.ok(!custom.includes('secret')); assert.ok(!custom.includes('user'));
});

test('folder names and nested Unicode paths map to Nutstore URLs and back', () => {
  for (const folder of ['PicoBox', '阅读/Pico Box', '百分比%/周记#1', '文档?收藏']) {
    assert.equal(endpointFolder(folderEndpoint(folder)), folder);
  }
  assert.equal(folderEndpoint(' PicoBox '), 'https://dav.jianguoyun.com/dav/PicoBox/');
  assert.equal(endpointFolder('https://dav.jianguoyun.com/dav/PicoBox'), 'PicoBox');
  assert.equal(endpointFolder(folderEndpoint('文'.repeat(80))),'文'.repeat(80));
  assert.throws(()=>folderEndpoint('文'.repeat(81)));
});
test('invalid edits and foreign or ambiguous URLs cannot become Nutstore folders', () => {
  for (const folder of ['', '/', '/PicoBox', 'PicoBox/', 'a//b', 'a/../b', './a', 'a\\b', 'a\n']) {
    if(folder==='a\n') assert.equal(folderEndpoint(folder),folderEndpoint('a'));
    else assert.throws(() => folderEndpoint(folder));
  }
  for(const url of ['http://dav.jianguoyun.com/dav/PicoBox/', 'https://other.example/dav/box/',
    'https://user@dav.jianguoyun.com/dav/box/', 'https://dav.jianguoyun.com/dav/a%2fb/',
    'https://dav.jianguoyun.com/dav/a?secret=x', 'https://dav.jianguoyun.com/dav/%ff/']) {
    assert.equal(endpointFolder(url), undefined);
  }
});
test('one default scope identifies the same filename across source folders', async () => {
  assert.equal(await articleId(DEFAULT_SCOPE,'电脑/周记1.md'),await articleId(DEFAULT_SCOPE,'手机/周记1.md'));
  assert.notEqual(await articleId(DEFAULT_SCOPE,'周记1.md'),await articleId(DEFAULT_SCOPE,'周记2.md'));
});
