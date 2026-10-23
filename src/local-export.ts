/* SPDX-License-Identifier: Apache-2.0
 * 中文：输出可直接拷卡的正文与附件，不修改源笔记，也不依赖桌面Node接口。
 * English: export card-ready text/assets without modifying source notes or requiring desktop Node APIs.
 */
import { sha256, sourceFilename, utf8 } from './protocol';
import type { ImageExport } from './export-images';
export const LOCAL_EXPORT_ROOT = 'E-ink Reader导出';
export interface ExportStorage {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export async function exportLocal(storage: ExportStorage, sourcePath: string, note: ImageExport): Promise<string> {
  const target = `${LOCAL_EXPORT_ROOT}/${sourceFilename(sourcePath)}`;
  if (sourcePath === target) throw new Error('请从原笔记导出，不能覆盖正在阅读的导出文件。');
  if (utf8(note.body).length > 256 * 1024) throw new Error('正文超过256KiB，未导出。');
  const temporary = target + '.part', backup = target + '.before';
  if (!await storage.exists(LOCAL_EXPORT_ROOT)) await storage.mkdir(LOCAL_EXPORT_ROOT);
  // 上次中断仅留备份时先恢复；现有正文存在时保留它并清理旧备份。
  // Restore a backup-only interrupted export; otherwise preserve the body and discard its stale backup.
  if (await storage.exists(backup)) {
    if (!await storage.exists(target)) await storage.rename(backup, target);
    else await storage.remove(backup);
  }
  if (note.assets.length && !await storage.exists(LOCAL_EXPORT_ROOT + '/attachments')) await storage.mkdir(LOCAL_EXPORT_ROOT + '/attachments');
  for (const asset of note.assets) {
    // eslint-disable-next-line no-control-regex -- Reject control characters in generated local attachment names.
    if (!/^[^/\\]+-[a-f0-9]{16}\.png$/.test(asset.name) || /[\u0000-\u001f]/.test(asset.name)) throw new Error('导出附件名无效。');
    const path = `${LOCAL_EXPORT_ROOT}/attachments/${asset.name}`;
    if (await storage.exists(path)) {
      if (await sha256(new Uint8Array(await storage.readBinary(path))) !== await sha256(asset.data)) throw new Error('导出目录同名图片内容冲突。');
    } else {
      await storage.writeBinary(path, new Uint8Array(asset.data).buffer);
      if (await sha256(new Uint8Array(await storage.readBinary(path))) !== await sha256(asset.data)) throw new Error('导出图片校验失败。');
    }
  }
  await storage.write(temporary, note.body);
  if (await sha256(new Uint8Array(await storage.readBinary(temporary))) !== await sha256(utf8(note.body))) throw new Error('导出正文校验失败。');
  const existed = await storage.exists(target);
  if (existed) await storage.rename(target, backup);
  try { await storage.rename(temporary, target); }
  catch (error) {
    if (existed && !await storage.exists(target)) await storage.rename(backup, target);
    throw error;
  }
  if (existed) await storage.remove(backup);
  return target;
}
