/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：文本与灰度 PNG 文章协议与边界校验。
 * English: text and grayscale PNG protocol and boundary validation.
 * 冻结：只接受有界的文本 v1 与图片 v2 协议，不读取凭据或源笔记。
 * Frozen: accept bounded text v1 and image v2 only; never access credentials or source notes.
 */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_PATH_BYTES = 240;
export const MAX_ASSETS = 64;
export const MAX_ASSET_BYTES = 17 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 32 * 1024;
export interface AssetManifest { path: string; mime: 'image/png'; bytes: number; sha256: string; width: number; height: number; source_sha256?: string }
export interface ArticleManifest {
  schema_version: 1 | 2;
  article_id: string;
  revision_id: string;
  title: string;
  source_filename?: string;
  created_at: string;
  updated_at: string;
  body: { path: string; mime: 'text/markdown'; bytes: number; sha256: string };
  assets: AssetManifest[];
}
export function utf8(text: string): Uint8Array {
  // 中文：TextEncoder 默认替换孤立代理项，协议必须先拒绝以保留准确内容。/ English: reject lone surrogates before TextEncoder can silently replace them.
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('文本包含孤立 UTF-16 代理项，无法严格编码为 UTF-8。');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('文本包含孤立 UTF-16 代理项，无法严格编码为 UTF-8。');
    }
  }
  return new TextEncoder().encode(text);
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(bytes).buffer;
  const hash = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function normalizedPath(path: string): string {
  const value = path.normalize('NFC');
  if (!value || /[\\\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/') ||
      value.split('/').some(p => !p || p === '.' || p === '..') || utf8(value).length > MAX_PATH_BYTES) {
    throw new Error('路径无效，或 UTF-8 长度超过 240 字节。');
  }
  return value;
}
// 中文：源文件名是字面 basename，不能用显示标题或哈希反推。
// English: source filenames are literal basenames; titles and hashes cannot reconstruct them.
export function validSourceFilename(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFC') && value.length > 3 && /\.md$/i.test(value) &&
    !/[\/\\\u0000-\u001f\u007f]/u.test(value) && utf8(value).length <= MAX_PATH_BYTES;
}
export function sourceFilename(vaultPath: string): string {
  const filename = normalizedPath(vaultPath).split('/').at(-1)!;
  if (!validSourceFilename(filename)) throw new Error('源文件名必须是有界的 Markdown basename。');
  return filename;
}
export async function articleId(namespace: string, vaultPath: string): Promise<string> {
  const scope = namespace.trim().normalize('NFC');
  if (!scope || utf8(scope).length > 128 || /[\u0000-\u001f\u007f]/u.test(scope)) {
    throw new Error('请设置非空的共享 namespace（最多 128 UTF-8 字节）。');
  }
  const filename = normalizedPath(vaultPath).split('/').at(-1)!;
  return sha256(utf8(scope + '\0' + filename));
}
export const bodyPath = (id: string, revision: string): string => `_pico/${id}/${revision}/body.md`;
const hexId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v.replace('.000Z', 'Z');
export function parseManifest(text: string, expectedId: string): ArticleManifest {
  if (utf8(text).length > MAX_MANIFEST_BYTES) throw new Error('清单超过协议上限。');
  const m = JSON.parse(text);
  if (!m || (m.schema_version !== 1 && m.schema_version !== 2) || !hexId(m.article_id) || m.article_id !== expectedId ||
      !hexId(m.revision_id) || typeof m.title !== 'string' || !m.title.trim() || utf8(m.title).length > 240 ||
      (m.source_filename !== undefined && !validSourceFilename(m.source_filename)) ||
      !timestamp(m.created_at) || !timestamp(m.updated_at) || Date.parse(m.created_at) > Date.parse(m.updated_at) ||
      !m.body || m.body.path !== bodyPath(m.article_id, m.revision_id) || m.body.mime !== 'text/markdown' ||
      !Number.isInteger(m.body.bytes) || m.body.bytes < 0 || m.body.bytes > MAX_BODY_BYTES ||
      !hexId(m.body.sha256) || !Array.isArray(m.assets) || m.assets.length > MAX_ASSETS ||
      (m.schema_version === 1 && (m.body.sha256 !== m.revision_id || m.assets.length !== 0)) ||
      (m.schema_version === 2 && m.assets.length === 0)) {
    throw new Error('云端清单不符合 Pico 协议，已停止覆盖。');
  }
  normalizedPath(m.body.path);
  if (m.schema_version === 1 && utf8(text).length > 4096) throw new Error('清单超过文本协议上限。');
  const prefix = `_pico/${m.article_id}/${m.revision_id}/attachments/`;
  const paths = new Set<string>();
  let total = 0;
  const assets: AssetManifest[] = m.assets.map((a: AssetManifest) => {
    if (!a || typeof a.path !== 'string' || !a.path.startsWith(prefix) ||
        !/^[^/]+-[a-f0-9]{16}\.png$/.test(a.path.slice(prefix.length)) ||
        a.mime !== 'image/png' || !Number.isInteger(a.bytes) || a.bytes < 67 || a.bytes > MAX_ASSET_BYTES ||
        !hexId(a.sha256) || (a.source_sha256 !== undefined && !hexId(a.source_sha256)) || !Number.isInteger(a.width) || a.width < 1 || a.width > 684 ||
        !Number.isInteger(a.height) || a.height < 1 || a.width * a.height > 32 * 1024 * 1024 || paths.has(a.path)) {
      throw new Error('云端清单附件无效，已停止覆盖。');
    }
    if (normalizedPath(a.path) !== a.path) throw new Error('云端清单附件路径未规范化，已停止覆盖。');
    paths.add(a.path); total += a.bytes;
    return { path: a.path, mime: a.mime, bytes: a.bytes, sha256: a.sha256, width: a.width, height: a.height, ...(a.source_sha256 ? { source_sha256: a.source_sha256 } : {}) };
  });
  if (total > MAX_TOTAL_ASSET_BYTES) throw new Error('云端清单附件总量超过上限。');
  return {
    schema_version: m.schema_version, article_id: m.article_id, revision_id: m.revision_id, title: m.title,
    ...(m.source_filename !== undefined ? { source_filename: m.source_filename } : {}),
    created_at: m.created_at, updated_at: m.updated_at,
    body: { path: m.body.path, mime: m.body.mime, bytes: m.body.bytes, sha256: m.body.sha256 }, assets
  };
}
export function encodePath(path: string): string {
  return normalizedPath(path).split('/').map(encodeURIComponent).join('/');
}
