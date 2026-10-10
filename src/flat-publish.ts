/* SPDX-License-Identifier: Apache-2.0
 * 中文：原文件名直写收件根目录，最后写入覆盖并回读准确正文。
 * English: write the original filename directly to the inbox; last writer wins with exact-byte verification.
 * 冻结：不建目录、附件或清单、不删除云文件；已发出PUT即使取消也确认结果。
 * Frozen: no directories, assets, manifests or deletes; verify dispatched PUTs even when cancelled.
 */
import { MAX_BODY_BYTES, sha256, sourceFilename, utf8 } from './protocol';
import { PublishError, type Cancellation, type DavResponse, type DavTransport, type PublishStage } from './publish';
export interface FlatResult { filename: string; bytes: number; sha256: string; unchanged: boolean; cancelRequested: boolean }
function cancelled(cancel: Cancellation): void { if (cancel.requested) throw new PublishError('已取消发送，尚未写入云端文件。', 'cancelled'); }
async function matches(response: DavResponse, bytes: Uint8Array, hash: string): Promise<boolean> {
  if (response.status !== 200) return false;
  const remote = response.bytes !== undefined ? new Uint8Array(response.bytes) : utf8(response.text);
  return remote.length === bytes.length && await sha256(remote) === hash;
}
export async function publishFlat(transport: DavTransport, input: { vaultPath: string; body: string }, cancel: Cancellation,
  stage: (value: PublishStage) => void = () => {}): Promise<FlatResult> {
  if (input.body.includes('\0')) throw new PublishError('正文包含 NUL 字符，尚未发送。');
  let bytes: Uint8Array;
  try { bytes = utf8(input.body); } catch { throw new PublishError('正文包含孤立 UTF-16 代理项，尚未发送。'); }
  if (bytes.length > MAX_BODY_BYTES) throw new PublishError('正文超过 256 KiB，尚未发送。');
  const filename = sourceFilename(input.vaultPath), hash = await sha256(bytes);
  const result = { filename, bytes: bytes.length, sha256: hash, unchanged: false, cancelRequested: false };
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
