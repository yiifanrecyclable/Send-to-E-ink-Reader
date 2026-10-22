/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：只读解析笔记图片，生成文章独占附件并重写导出正文。
 * English: read-only image resolution, article-owned attachment copies and exported Markdown rewriting.
 * 冻结：不下载远程图片、不展开笔记；不支持图片需警告并转文字占位，不改源文件或代码。
 * Frozen: never fetch remote images or expand notes; warn and replace unsupported images with text, preserving sources and code.
 */
import { preprocess, proseSegments, type TextExport } from './preprocess';
import { type GrayImage } from './image';
import { sha256, utf8, MAX_ASSETS, MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES } from './protocol';
export interface ExportAsset extends GrayImage { name: string; source_sha256: string }
export interface ImageExport extends TextExport { assets: ExportAsset[] }
export interface ImageSource { key: string; read(): Promise<ArrayBuffer>; mime: string }
export interface ImageExportEnvironment {
  resolve(target: string): ImageSource | undefined;
  convert(source: ArrayBuffer, mime: string): Promise<GrayImage>;
  random?(): string;
  cancelled?(): boolean;
}
interface Reference { start: number; end: number; target?: string; alt: string }
const unescape = (value: string): string => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
const refKey = (value: string): string => unescape(value).trim().replace(/\s+/g, ' ').toLowerCase();
const escaped = (text: string, position: number): boolean => {
  let count = 0; while (position > 0 && text[--position] === '\\') count++; return count % 2 === 1;
};
function destination(text: string): string | undefined {
  const match = /^\s*(?:<([^<>\n]*)>|((?:\\.|[^\s])+?))(?:\s+["'].*["']\s*)?$/.exec(text);
  return match ? unescape(match[1] ?? match[2]) : undefined;
}
export function imageReferences(text: string, definitions = new Map<string, string>()): Reference[] {
  const result: Reference[] = [];
  for (let start = 0; start < text.length - 1; start++) {
    if (text[start] !== '!' || text[start + 1] !== '[' || escaped(text, start)) continue;
    if (text[start + 2] === '[') {
      const end = text.indexOf(']]', start + 3);
      if (end < 0) continue;
      const target = text.slice(start + 3, end).split('|')[0];
      result.push({ start, end: end + 2, target, alt: target.split('/').at(-1) ?? target }); start = end + 1; continue;
    }
    let close = start + 2, depth = 1;
    for (; close < text.length; close++) {
      if (escaped(text, close)) continue;
      if (text[close] === '[') depth++;
      if (text[close] === ']' && --depth === 0) break;
    }
    if (close >= text.length) continue;
    const alt = text.slice(start + 2, close);
    let end = close + 1, target: string | undefined;
    if (text[end] === '(') {
      let nesting = 1, cursor = end + 1, angle = false, quote = '';
      for (; cursor < text.length; cursor++) {
        if (escaped(text, cursor)) continue;
        const char = text[cursor];
        if (quote) { if (char === quote) quote = ''; continue; }
        if ((char === '"' || char === "'") && /\s/.test(text[cursor - 1])) { quote = char; continue; }
        if (char === '<') angle = true;
        if (char === '>') angle = false;
        if (!angle && char === '(') nesting++;
        if (!angle && char === ')' && --nesting === 0) break;
      }
      if (cursor >= text.length) continue;
      target = destination(text.slice(end + 1, cursor)); end = cursor + 1;
    } else if (text[end] === '[') {
      const labelEnd = text.indexOf(']', end + 1);
      if (labelEnd < 0) continue;
      target = definitions.get(refKey(text.slice(end + 1, labelEnd) || alt)); end = labelEnd + 1;
    } else target = definitions.get(refKey(alt));
    result.push({ start, end, target, alt }); start = end - 1;
  }
  return result;
}
function safeName(articleName: string, suffix: string): string {
  // eslint-disable-next-line no-control-regex -- Reject unsafe path/filename control characters before WebDAV encoding.
  let prefix = articleName.normalize('NFC').replace(/[/\\\u0000-\u001f\u007f<>:"|?*]/g, '_').trim() || 'article';
  // 中文：双 SHA256 目录已占路径空间，附件文件名限 96 UTF-8 字节。
  // English: two SHA256 directories consume path space; bound attachment names to 96 UTF-8 bytes.
  while (utf8(prefix).length > 70) prefix = Array.from(prefix).slice(0, -1).join('');
  if (!/^[a-f0-9]{16}$/.test(suffix)) throw new Error('附件随机标识无效。');
  return `${prefix}-${suffix}.png`;
}
const random = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('');
// 中文：占位为转义后的普通文字，标签本身也不能注入新图片语法。
// English: placeholders are escaped prose; labels cannot inject another image reference.
export function imagePlaceholder(alt: string): string {
  const label = unescape(alt).replace(/[\r\n]/g, ' ').trim() || '图片';
  return `（图片或嵌入未导出：${label.replace(/[\\`*_{}[\]()<>#!|&]/g, '\\$&')}）`;
}
export async function exportImages(source: string, articleName: string, environment: ImageExportEnvironment): Promise<ImageExport> {
  const exported = preprocess(source, articleName, true);
  const parts = proseSegments(exported.body);
  const definitions = new Map<string, string>();
  for (const part of parts) if (!part.protected) {
    for (const match of part.text.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(.+)$/gm)) {
      const target = destination(match[2]); if (target !== undefined) definitions.set(refKey(match[1]), target);
    }
  }
  const warnings = new Set(exported.warnings), assets: ExportAsset[] = [];
  const reused = new Map<string, ExportAsset>();
  let total = 0;
  const output: string[] = [];
  for (const part of parts) {
    if (part.protected) { output.push(part.text); continue; }
    let cursor = 0;
    const references = imageReferences(part.text, definitions);
    const appendProse = (text: string): void => {
      // 中文：复杂/未闭合引用退为字面文字，避免孤立引用使设备拒收整篇。
      // English: turn complex/incomplete references into literals so dangling images cannot reject the article.
      let downgraded = false;
      const escapedImages = text.replace(/!\[/g, (match, position: number) => {
        if (escaped(text, position)) return match;
        downgraded = true; return '\\!\\[';
      }).replace(/<img\b[^>]*>/gi, () => { downgraded = true; return imagePlaceholder('HTML 图片'); });
      if (downgraded) warnings.add('未支持的图片写法已转为普通文字占位或转义文字，不会保留无附件图片引用。');
      output.push(escapedImages);
    };
    for (const reference of references) {
      if (environment.cancelled?.()) throw new Error('图片导出已取消。');
      appendProse(part.text.slice(cursor, reference.start)); cursor = reference.end;
      if (reference.target === undefined) {
        warnings.add('图片引用缺失或格式不支持，已改为文字占位。'); output.push(imagePlaceholder(reference.alt)); continue;
      }
      let target: string;
      try { target = decodeURIComponent(reference.target); } catch { target = reference.target; }
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(target)) {
        warnings.add('远程图片未下载，已改为文字占位；继续发送会省略该图片。'); output.push(imagePlaceholder(reference.alt)); continue;
      }
      const resolved = environment.resolve(target);
      if (!resolved) {
        warnings.add('图片或嵌入附件未找到或格式不支持，已改为文字占位；笔记嵌入不展开。'); output.push(imagePlaceholder(reference.alt)); continue;
      }
      let asset = reused.get(resolved.key);
      if (!asset) {
        if (assets.length >= MAX_ASSETS) throw new Error('文章图片超过 64 张，未发送。');
        let sourceHash: string, converted: GrayImage;
        try {
          const sourceBytes = await resolved.read();
          sourceHash = await sha256(new Uint8Array(sourceBytes));
          converted = await environment.convert(sourceBytes, resolved.mime);
        } catch {
          if (environment.cancelled?.()) throw new Error('图片导出已取消。');
          warnings.add('图片读取或转换失败，已改为文字占位；继续发送会省略该图片。');
          output.push(imagePlaceholder(reference.alt)); continue;
        }
        if (converted.data.length > MAX_ASSET_BYTES || total + converted.data.length > MAX_TOTAL_ASSET_BYTES) throw new Error('文章图片超过附件大小上限，未发送。');
        total += converted.data.length;
        const name = safeName(articleName, (environment.random ?? random)());
        if (assets.some(item => item.name === name)) throw new Error('附件随机标识重复，请重新发送。');
        asset = { ...converted, name, source_sha256: sourceHash }; reused.set(resolved.key, asset); assets.push(asset);
      }
      const alt = unescape(reference.alt).replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
      output.push(`![${alt}](attachments/${encodeURIComponent(asset.name)})`);
    }
    appendProse(part.text.slice(cursor));
  }
  return { ...exported, body: output.join(''), warnings: [...warnings], assets };
}
