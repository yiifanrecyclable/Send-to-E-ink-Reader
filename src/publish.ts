/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：通过可替换传输发布不可变正文与附件，最后发布清单并确认。
 * English: publish immutable text and assets through replaceable transport; commit and verify the manifest last.
 * 冻结：更新只用标准条件写；无变化只读确认；不盲覆盖、不删除旧版本、不声称请求可撤销。
 * Frozen: updates require standard conditional writes; unchanged exports only read; never blindly replace, delete revisions or claim reversibility.
 */
import { articleId, bodyPath, MAX_BODY_BYTES, MAX_ASSETS, MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, normalizedPath, sourceFilename, parseManifest, sha256, utf8, type ArticleManifest } from './protocol';
import { proseSegments } from './preprocess';

// 中文：传输替身与发布状态机不依赖 Obsidian。/ English: transport contract and publisher are independent of Obsidian.
export type DavBody = string | ArrayBuffer;
export interface DavResponse { status: number; text: string; bytes?: ArrayBuffer; headers: Record<string, string> }
export interface DavTransport {
  request(method: string, path: string, body?: DavBody, headers?: Record<string, string>): Promise<DavResponse>;
}
export interface Cancellation { requested: boolean }
export type PublishStage = 'checking' | 'uploading' | 'publishing' | 'confirming';
export class PublishError extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'cancelled' | 'uncertain' = 'failed') { super(message); }
}
export interface PublishAsset { name: string; data: Uint8Array; width: number; height: number; source_sha256?: string }
export interface PublishInput { namespace: string; vaultPath: string; title: string; body: string; assets?: PublishAsset[] }
export interface PublishResult { manifest: ArticleManifest; cancelRequested: boolean; unchanged?: boolean }
export const header = (response: DavResponse, name: string): string | undefined =>
  Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
// 中文：裸版本仅保留安全 opaque 字节并补标准引号，不降低为无条件覆盖。
// English: quote safe opaque bare tokens without ever downgrading to unconditional replacement.
export function conditionalEtag(value: string | undefined): string | undefined {
  if (!value || value.length > 128 || value.startsWith('W/')) return undefined;
  if (/^"[\x21\x23-\x7e]+"$/.test(value)) return value;
  if (/^[A-Za-z0-9._:-]+$/.test(value)) return `"${value}"`;
  return undefined;
}
function checkCancellation(cancel: Cancellation): void {
  if (cancel.requested) throw new PublishError('已取消后续上传，尚未发布新清单。', 'cancelled');
}
function requireSuccess(response: DavResponse, operation: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new PublishError(`${operation}失败（HTTP ${response.status}）。`);
  }
}
async function bodyMatches(response: DavResponse, length: number, hash: string): Promise<boolean> {
  const data = response.bytes !== undefined ? new Uint8Array(response.bytes) : utf8(response.text);
  return data.length === length && await sha256(data) === hash;
}
export async function publish(
  transport: DavTransport, input: PublishInput, cancel: Cancellation,
  stage: (value: PublishStage) => void = () => {}, now: () => Date = () => new Date()
): Promise<PublishResult> {
  if (input.body.includes('\0')) throw new PublishError('正文包含 NUL 字符，尚未发送。');
  let bytes: Uint8Array;
  try { bytes = utf8(input.body); }
  catch { throw new PublishError('正文包含孤立 UTF-16 代理项，尚未发送。'); }
  if (bytes.length > MAX_BODY_BYTES) throw new PublishError('正文超过 256 KiB，尚未发送。');
  if (!input.title.trim() || utf8(input.title).length > 240) throw new PublishError('标题为空或超过 240 UTF-8 字节。');
  const filename = sourceFilename(input.vaultPath);
  const id = await articleId(input.namespace, input.vaultPath);
  let body = input.body;
  let assets = await Promise.all((input.assets ?? []).map(async asset => {
    const name = normalizedPath(asset.name);
    if (!/^[^/]+-[a-f0-9]{16}\.png$/.test(name) || asset.data.length < 67 || asset.data.length > MAX_ASSET_BYTES ||
        (asset.source_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(asset.source_sha256)) ||
        !Number.isInteger(asset.width) || asset.width < 1 || asset.width > 684 ||
        !Number.isInteger(asset.height) || asset.height < 1 || asset.width * asset.height > 32 * 1024 * 1024) {
      throw new PublishError('图片附件描述无效，尚未发送。');
    }
    const png = asset.data;
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    if (png.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10' ||
        view.getUint32(8) !== 13 || png.slice(12, 16).join(',') !== '73,72,68,82' ||
        view.getUint32(16) !== asset.width || view.getUint32(20) !== asset.height || png[24] !== 4 || png[25] !== 0 || png[28] !== 0) {
      throw new PublishError('图片附件必须为 4 位灰度 PNG，尚未发送。');
    }
    return { ...asset, name, sha256: await sha256(asset.data) };
  }));
  if (assets.length > MAX_ASSETS || new Set(assets.map(a => a.name)).size !== assets.length ||
      assets.reduce((sum, a) => sum + a.data.length, 0) > MAX_TOTAL_ASSET_BYTES) throw new PublishError('文章附件数量或总大小超限，尚未发送。');
  const path = `${id}.pico.json`;
  checkCancellation(cancel); stage('checking');
  const previous = await transport.request('GET', path);
  let old: ArticleManifest | undefined;
  let etag: string | undefined;
  if (previous.status === 200) {
    old = parseManifest(previous.text, id);
    etag = conditionalEtag(header(previous, 'etag'));
  } else if (previous.status !== 404) throw new PublishError(`读取旧清单失败（HTTP ${previous.status}）。`);
  // 中文：相同图片复用旧附件名，随机导出名称不会触发无内容变化的更新。
  // English: reuse names for identical images so random export names never create content-free updates.
  if (old?.assets.length) {
    const available = [...old.assets];
    const replacements = new Map<string, string>();
    const reused = [];
    for (const asset of assets) {
      const match = available.findIndex(a => (a.sha256 === asset.sha256 ||
        (asset.source_sha256 && a.source_sha256 === asset.source_sha256)) && a.width === asset.width && a.height === asset.height);
      if (match < 0) { reused.push(asset); continue; }
      const oldAsset = available.splice(match, 1)[0];
      const name = oldAsset.path.split('/').at(-1)!;
      replacements.set(`attachments/${encodeURIComponent(asset.name)}`, `attachments/${encodeURIComponent(name)}`);
      let data = asset.data;
      if (oldAsset.sha256 !== asset.sha256) {
        checkCancellation(cancel);
        const response = await transport.request('GET', oldAsset.path);
        requireSuccess(response, '校验已有附件');
        if (!response.bytes || response.bytes.byteLength !== oldAsset.bytes || await sha256(new Uint8Array(response.bytes)) !== oldAsset.sha256) throw new PublishError('不可变版本附件不匹配，已停止发布。');
        data = new Uint8Array(response.bytes);
      }
      reused.push({ ...asset, name, data, sha256: oldAsset.sha256 });
    }
    assets = reused;
    body = proseSegments(body).map(part => part.protected ? part.text :
      part.text.replace(/attachments\/[^\s)<>]+/g, target => replacements.get(target) ?? target)).join('');
    bytes = utf8(body);
    if (bytes.length > MAX_BODY_BYTES) throw new PublishError('正文超过 256 KiB，尚未发送。');
  }
  const bodyHash = await sha256(bytes);
  const revision = assets.length ? await sha256(utf8(JSON.stringify({ body: bodyHash,
    assets: assets.map(a => ({ name: a.name, sha256: a.sha256, ...(a.source_sha256 ? { source_sha256: a.source_sha256 } : {}) })) }))) : bodyHash;
  const time = now().toISOString();
  if (old && Date.parse(old.created_at) > Date.parse(time)) throw new PublishError('云端创建时间晚于本机时间，请校准时钟。');
  const manifest: ArticleManifest = {
    schema_version: assets.length ? 2 : 1, article_id: id, revision_id: revision, title: input.title, source_filename: filename,
    created_at: old?.created_at ?? time, updated_at: time,
    body: { path: bodyPath(id, revision), mime: 'text/markdown', bytes: bytes.length, sha256: bodyHash }, assets: assets.map(a => ({
      path: `_pico/${id}/${revision}/attachments/${a.name}`, mime: 'image/png', bytes: a.data.length, sha256: a.sha256, width: a.width, height: a.height, ...(a.source_sha256 ? { source_sha256: a.source_sha256 } : {})
    }))
  };
  const payload = JSON.stringify(manifest);
  parseManifest(payload, id);
  if (old && old.title === manifest.title && old.source_filename === manifest.source_filename && old.revision_id === revision && old.body.sha256 === bodyHash &&
      JSON.stringify(old.assets) === JSON.stringify(manifest.assets)) {
    checkCancellation(cancel);
    const existing = await transport.request('GET', old.body.path);
    requireSuccess(existing, '校验已有正文');
    if (!await bodyMatches(existing, bytes.length, bodyHash)) throw new PublishError('不可变版本正文不匹配，已停止发布。');
    for (const asset of old.assets) {
      checkCancellation(cancel);
      const response = await transport.request('GET', asset.path);
      requireSuccess(response, '校验已有附件');
      if (!response.bytes || response.bytes.byteLength !== asset.bytes || await sha256(new Uint8Array(response.bytes)) !== asset.sha256) throw new PublishError('不可变版本附件不匹配，已停止发布。');
    }
    // 中文：无变化无需版本条件，但资源验证后要再次确认清单没有换版本。
    // English: no-op requires no write validator, but confirm the manifest again after checking resources.
    checkCancellation(cancel);
    const readback = await transport.request('GET', path);
    requireSuccess(readback, '确认未变化清单');
    if (JSON.stringify(parseManifest(readback.text, id)) !== JSON.stringify(old)) throw new PublishError('云端文章已被另一端更新，请重新发送。');
    return { manifest: old, cancelRequested: cancel.requested, unchanged: true };
  }
  if (old && !etag) throw new PublishError('云端未提供可用的条件更新标记，无法安全覆盖；内容未变化时仍可校验。请更换测试目录或确认服务支持条件写。');
  stage('uploading');
  for (const folder of ['_pico', `_pico/${id}`, `_pico/${id}/${revision}`, ...(assets.length ? [`_pico/${id}/${revision}/attachments`] : [])]) {
    checkCancellation(cancel);
    const response = await transport.request('MKCOL', folder);
    // 中文：405 允许继续，后续 PUT 仍须验证成功。/ English: continue on 405, but subsequent PUT must succeed.
    if (response.status !== 405) requireSuccess(response, '创建版本目录');
  }
  checkCancellation(cancel);
  const uploaded = await transport.request('PUT', manifest.body.path, body,
    { 'Content-Type': 'text/markdown; charset=utf-8', 'If-None-Match': '*' });
  if (uploaded.status === 412) {
    checkCancellation(cancel);
    const existing = await transport.request('GET', manifest.body.path);
    requireSuccess(existing, '校验已有正文');
    if (!await bodyMatches(existing, bytes.length, bodyHash)) {
      throw new PublishError('不可变版本正文不匹配，已停止发布。');
    }
  } else requireSuccess(uploaded, '上传正文');
  if (uploaded.status !== 412) {
    // 中文：PUT 成功不证明正文已保存；发布清单前必须按准确字节回读。
    // English: successful PUT does not prove storage; verify exact body bytes before committing the manifest.
    checkCancellation(cancel);
    const readback = await transport.request('GET', manifest.body.path);
    requireSuccess(readback, '校验上传正文');
    if (!await bodyMatches(readback, bytes.length, bodyHash)) {
      throw new PublishError('云端正文回读不匹配，未发布清单。请检查收件目录或服务兼容性。');
    }
  }
  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index], descriptor = manifest.assets[index];
    checkCancellation(cancel);
    const response = await transport.request('PUT', descriptor.path, new Uint8Array(asset.data).buffer,
      { 'Content-Type': 'image/png', 'If-None-Match': '*' });
    if (response.status !== 412) requireSuccess(response, '上传附件');
    checkCancellation(cancel);
    const readback = await transport.request('GET', descriptor.path);
    requireSuccess(readback, '校验附件');
    if (!readback.bytes || readback.bytes.byteLength !== descriptor.bytes || await sha256(new Uint8Array(readback.bytes)) !== descriptor.sha256) {
      throw new PublishError('不可变版本附件不匹配，已停止发布。');
    }
  }
  checkCancellation(cancel); stage('publishing'); checkCancellation(cancel);
  let publicationError: unknown;
  try {
    const committed = await transport.request('PUT', path, payload, {
      'Content-Type': 'application/json; charset=utf-8', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' })
    });
    if (committed.status === 412) throw new PublishError('云端文章已被另一端更新，请重新发送。');
    if ([400, 405, 501].includes(committed.status)) throw new PublishError('云端未接受条件更新，已停止覆盖；不会改为无条件发送。请在专用测试目录确认兼容性。');
    requireSuccess(committed, '发布清单');
  } catch (error) { publicationError = error; }
  // 中文：清单发出后即使取消/连接报错也确认实际结果。/ English: confirm actual state after dispatch, even on cancellation/error.
  stage('confirming');
  let confirmed: ArticleManifest;
  try {
    const response = await transport.request('GET', path);
    requireSuccess(response, '回读清单');
    confirmed = parseManifest(response.text, id);
    if (JSON.stringify(confirmed) !== payload) {
      if (publicationError instanceof PublishError) throw publicationError;
      throw new PublishError('云端回读版本与本次不一致，请刷新后重试。');
    }
  } catch (error) {
    if (publicationError instanceof PublishError) throw publicationError;
    if (error instanceof PublishError && error.outcome === 'failed' && error.message.includes('不一致')) throw error;
    throw new PublishError('清单发布结果尚未确认；可能已经发布，请联网后重新检查。', 'uncertain');
  }
  return { manifest: confirmed, cancelRequested: cancel.requested };
}
