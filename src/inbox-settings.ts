/* SPDX-License-Identifier: Apache-2.0
 * 中文：普通用户只填坚果云收件路径；DEFAULT_SCOPE仅供历史离线协议兼容。
 * English: expose a Nutstore folder path; DEFAULT_SCOPE serves historical offline protocol compatibility only.
 */
export const DEFAULT_SCOPE = 'if-pico';
export function flatInboxReceipt(endpoint: string, filename: string): string {
  const url = new URL(endpoint), folder = endpointFolder(endpoint);
  const location = folder !== undefined ? `坚果云：${folder}/${filename}` : `${url.origin}${url.pathname.replace(/\/?$/, '/')}${encodeURIComponent(filename)}`;
  return `云端文件：${location}\n已发送纯文本正文；本次未发送图片。请在 Pico 云列表手动选择此 .md 文件下载。`;
}
// 中文：用户可据此找到实际保存文件；不显示账号、密码或URL查询。
// English: locate actual cloud files without exposing URL credentials or query parameters.
export function inboxReceipt(endpoint: string, id: string, bodyPath: string): string {
  const folder = endpointFolder(endpoint);
  const url = new URL(endpoint);
  const location = folder !== undefined ? `坚果云：${folder}/` : `${url.origin}${url.pathname.replace(/\/?$/, '/')}`;
  return `收件位置：${location}\n清单文件：${id}.pico.json\n正文文件：${bodyPath}\n正文位于 _pico 子目录，收件根目录不会生成原名 .md；在 Pico 云列表手动下载。`;
}
export function folderEndpoint(folder: string): string {
  const path = folder.trim();
  if (new TextEncoder().encode(path).length > 240) throw new Error('收件文件夹路径超过 Pico 的240 UTF-8字节上限。');
  const parts = path.split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error('收件文件夹不能为空，不使用前后斜杠、连续斜杠或 .、.. 路径。');
  }
  return 'https://dav.jianguoyun.com/dav/' + parts.map(part => encodeURIComponent(part)).join('/') + '/';
}
export function endpointFolder(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.origin !== 'https://dav.jianguoyun.com' || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/dav/')) return undefined;
    const raw = url.pathname.slice(5).replace(/\/$/, '');
    const parts = raw.split('/').map(part => decodeURIComponent(part));
    if (parts.some(part => part.includes('/'))) return undefined;
    const folder = parts.join('/'); folderEndpoint(folder); return folder;
  } catch { return undefined; }
}
