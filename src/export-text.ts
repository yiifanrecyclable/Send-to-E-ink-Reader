/* SPDX-License-Identifier: Apache-2.0
 * 中文：第一阶段只导出正文；图片为转义文字占位，不读取附件。
 * English: stage one exports text only; escaped image placeholders never read attachments.
 */
import { preprocess, proseSegments, type TextExport } from './preprocess';
import { imageReferences, imagePlaceholder } from './export-images';
export function exportText(source: string, fallbackTitle: string): TextExport {
  const exported = preprocess(source, fallbackTitle, true);
  let omitted = false;
  const literal = (text: string): string => text.replace(/(!\[)|(<img\b[^>]*>)/gi, (match, image, html, offset: number) => {
    let slashes = 0; for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
    if (slashes % 2) return match;
    omitted = true; return html ? imagePlaceholder('HTML 图片') : '\\!\\[';
  });
  const body = proseSegments(exported.body).map(part => {
    if (part.protected) return part.text;
    let cursor = 0, output = '';
    for (const reference of imageReferences(part.text)) {
      output += literal(part.text.slice(cursor, reference.start)); cursor = reference.end;
      output += imagePlaceholder(reference.alt); omitted = true;
    }
    return output + literal(part.text.slice(cursor));
  }).join('');
  return { ...exported, body, warnings: [...exported.warnings, ...(omitted ? ['本次未发送图片或嵌入附件，已改为文字说明；只发送正文，代码示例保留原样。'] : [])] };
}
