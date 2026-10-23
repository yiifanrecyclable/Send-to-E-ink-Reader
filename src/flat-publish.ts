/* SPDX-License-Identifier: Apache-2.0
 * 中文：原文件名直写收件根目录，最后写入覆盖并回读准确正文。
 * English: write the original filename directly to the inbox; last writer wins with exact-byte verification.
 * 用户修订：仅创建attachments；先核验不可变图片，最后写正文，不删除云文件或创建清单。
 * User revision: only create attachments, verify immutable images before text, and never delete cloud files or create manifests.
 */
import { MAX_BODY_BYTES, normalizedPath, sha256, sourceFilename, utf8 } from './protocol';
import { EXPORT_IMAGE_BYTES, EXPORT_TOTAL_BYTES, EXPORT_IMAGE_PIXELS, EXPORT_IMAGE_HEIGHT } from './device-profile';
import { PublishError, type Cancellation, type DavResponse, type DavTransport, type PublishStage, type PublishAsset } from './publish';
export interface FlatResult { filename: string; bytes: number; sha256: string; unchanged: boolean; cancelRequested: boolean }
function cancelled(cancel: Cancellation): void { if (cancel.requested) throw new PublishError('已取消发送，尚未写入云端文件。', 'cancelled'); }
async function matches(response: DavResponse, bytes: Uint8Array, hash: string): Promise<boolean> {
  if (response.status !== 200) return false;
  const remote = response.bytes !== undefined ? new Uint8Array(response.bytes) : utf8(response.text);
  return remote.length === bytes.length && await sha256(remote) === hash;
}
export async function publishFlat(transport: DavTransport, input: { vaultPath: string; body: string; assets?: PublishAsset[] }, cancel: Cancellation,
  stage: (value: PublishStage) => void = () => {}): Promise<FlatResult> {
  if (input.body.includes('\0')) throw new PublishError('正文包含 NUL 字符，尚未发送。');
  let bytes: Uint8Array;
  try { bytes = utf8(input.body); } catch { throw new PublishError('正文包含孤立 UTF-16 代理项，尚未发送。'); }
  if (bytes.length > MAX_BODY_BYTES) throw new PublishError('正文超过 256 KiB，尚未发送。');
  const filename = sourceFilename(input.vaultPath), hash = await sha256(bytes);
  const result = { filename, bytes: bytes.length, sha256: hash, unchanged: false, cancelRequested: false };
  // 中文：无图片时不创建目录或额外请求，保持原纯文本发送路径。
  // English: text-only exports create no directories or additional requests.
  const assets = input.assets ?? [];
  if (assets.length > 64 || assets.reduce((sum, a) => sum + a.data.length, 0) > EXPORT_TOTAL_BYTES)
    throw new PublishError('文章图片超过数量或体积上限，尚未发送。');
  const names = new Set<string>();
  for (const asset of assets) {
    const name = normalizedPath(asset.name), png = asset.data;
    if (name.includes('/') || utf8(name).length > 96 || !/^[^/]+-[a-f0-9]{16}\.png$/.test(name) ||
        names.has(name.toLowerCase()) || png.length < 67 || png.length > EXPORT_IMAGE_BYTES ||
        !Number.isInteger(asset.width) || asset.width < 1 || asset.width > 4096 ||
        !Number.isInteger(asset.height) || asset.height < 1 || asset.height > EXPORT_IMAGE_HEIGHT ||
        asset.width * asset.height > EXPORT_IMAGE_PIXELS) throw new PublishError('图片附件描述无效，尚未发送。');
    names.add(name.toLowerCase());
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    if (png.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10' || view.getUint32(8) !== 13 ||
        png.slice(12, 16).join(',') !== '73,72,68,82' || view.getUint32(16) !== asset.width ||
        view.getUint32(20) !== asset.height || ![1, 2, 4, 8].includes(png[24]) ||
        png[25] || png[26] || png[27] || png[28]) throw new PublishError('图片附件必须为非交错灰度PNG，尚未发送。');
  }
  if (assets.length) {
    cancelled(cancel); stage('uploading');
    const directory = await transport.request('MKCOL', 'attachments');
    if (![200, 201, 204, 405].includes(directory.status)) throw new PublishError(`创建附件文件夹失败（HTTP ${directory.status}），正文未发送。`);
    for (const asset of assets) {
      cancelled(cancel);
      const path = `attachments/${asset.name}`, digest = await sha256(asset.data);
      const old = await transport.request('GET', path);
      if (old.status === 200) {
        if (!await matches(old, asset.data, digest)) throw new PublishError('同名图片内容冲突，正文未发送。');
        continue;
      }
      if (old.status !== 404) throw new PublishError(`读取附件失败（HTTP ${old.status}），正文未发送。`);
      cancelled(cancel);
      try { await transport.request('PUT', path, new Uint8Array(asset.data).buffer,
        { 'Content-Type': 'image/png', 'If-None-Match': '*' }); } catch { /* 必须回读。/ Always read back. */ }
      const confirmation = await transport.request('GET', path);
      if (!await matches(confirmation, asset.data, digest)) throw new PublishError('图片上传未确认，正文未发送，请重试。');
    }
  }
  cancelled(cancel); stage('checking');
  const previous = await transport.request('GET', filename);
  if (previous.status !== 200 && previous.status !== 404) throw new PublishError(`读取云端文件失败（HTTP ${previous.status}），尚未写入。`);
  if (await matches(previous, bytes, hash)) {
    cancelled(cancel);
    const confirm = await transport.request('GET', filename);
    if (!await matches(confirm, bytes, hash)) throw new PublishError('云端文件已被另一端改变，请重新发送。');
    return { ...result, unchanged: true, cancelRequested: cancel.requested };
  }
  cancelled(cancel); stage('uploading'); cancelled(cancel);
  let failure: unknown;
  try {
    const written = await transport.request('PUT', filename, input.body, { 'Content-Type': 'text/markdown; charset=utf-8' });
    if (written.status < 200 || written.status >= 300) failure = new PublishError(`写入云端文件失败（HTTP ${written.status}）。`);
  } catch (error) { failure = error; }
  // 中文：在途PUT不能撤销，任何已发出写入都须回读实际结果。
  // English: an in-flight PUT cannot be revoked; confirm every dispatched write.
  stage('confirming');
  try {
    const confirm = await transport.request('GET', filename);
    if (await matches(confirm, bytes, hash)) return { ...result, cancelRequested: cancel.requested };
    if (failure instanceof PublishError) throw failure;
    if (confirm.status === 200) throw new PublishError('云端回读正文与本次不同，未确认发送成功；可能被另一端更新，请刷新后重试。');
  } catch (error) {
    if (error instanceof PublishError) throw error;
  }
  throw new PublishError('文件写入结果尚未确认，可能已经写入；联网后重新发送以检查，不能认为已撤销。', 'uncertain');
}
