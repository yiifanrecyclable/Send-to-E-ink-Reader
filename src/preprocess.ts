/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：保留代码内容，显式列出未支持内容。
 * English: preserve code and report unsupported content.
 * 冻结：不执行动态内容，不修改源笔记，图片仅处理导出副本。
 * Frozen: never execute dynamic content or modify notes; only process exported image copies.
 */
export interface TextExport { body: string; title: string; warnings: string[] }
export function preprocess(source: string, fallbackTitle: string, images = false): TextExport {
  const warnings = new Set<string>();
  let text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let title = fallbackTitle;
  const frontmatter = /^---[ \t]*\n/.test(text)
    ? /^---[ \t]*\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\n|$)/m.exec(text) : null;
  if (frontmatter) {
    // 中文：仅解析简单标题，复杂 YAML 不执行。/ English: extract a simple title without executing YAML.
    const match = /^title:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter[1]);
    if (match) {
      const value = match[1];
      if (/^".*"$/.test(value)) {
        try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') title = parsed; } catch { /* 保留文件名。/ Keep filename. */ }
      } else if (/^'.*'$/.test(value)) title = value.slice(1, -1).replace(/''/g, "'");
      else if (!/^[>|[{&*!]/.test(value)) title = value.replace(/\s+#.*$/, '').trim();
    }
    text = text.slice(frontmatter[0].length);
  } else if (/^---[ \t]*\n/.test(text)) warnings.add('未闭合的 frontmatter 将作为正文保留。');
  const output = proseSegments(text, warnings).map(part => part.protected ? part.text : convert(part.text, warnings, images));
  return { body: output.join(''), title: title.trim() || fallbackTitle, warnings: [...warnings] };
}

// 中文：导出与图片重写共享代码保护边界。/ English: exports and image rewriting share literal-code boundaries.
export function proseSegments(text: string, warnings = new Set<string>()): { text: string; protected: boolean }[] {
  let fence: { char: string; length: number } | undefined;
  const lines = text.split('\n');
  const protectedLines = lines.map(line => {
    const unquoted = line.replace(/^ {0,3}(?:> ?)+/, '').replace(/^ {0,3}(?:[-+*]|\d+[.)]) +/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(unquoted);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      }
      return true;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      if (/^(dataview|dataviewjs|mermaid|math|query)\b/i.test(marker[2].trim())) warnings.add('动态查询、公式或图表代码仅发送源码，Pico 不执行。');
      return true;
    }
    if (/^(?: {4}|\t)/.test(unquoted)) return true;
    if (/`\$?=/.test(line)) warnings.add('行内动态查询仅发送源码，Pico 不执行。');
    return false;
  });
  // 中文：按连续普通文本处理，跨行代码跨度也保持原样。/ English: process contiguous prose so multiline code spans stay literal.
  const output: { text: string; protected: boolean }[] = [];
  for (let i = 0; i < lines.length;) {
    if (protectedLines[i]) { output.push({ text: lines[i] + (i < lines.length - 1 ? '\n' : ''), protected: true }); i++; continue; }
    let end = i + 1;
    while (end < lines.length && !protectedLines[end]) end++;
    output.push(...inlineSegments(lines.slice(i, end).join('\n') + (end < lines.length ? '\n' : '')));
    i = end;
  }
  return output;
}
function escaped(text: string, offset: number): boolean {
  let slashes = 0;
  for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 !== 0;
}
function inlineSegments(text: string): { text: string; protected: boolean }[] {
  const runs = [...text.matchAll(/`+/g)];
  const nextSameLength = new Array<number>(runs.length).fill(-1);
  const last = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    nextSameLength[i] = last.get(runs[i][0].length) ?? -1;
    last.set(runs[i][0].length, i);
  }
  const parts: { text: string; protected: boolean }[] = [];
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const start = runs[i].index;
    const endRun = nextSameLength[i];
    if (escaped(text, start) || endRun < 0) continue;
    // 中文：空行分隔段落，不能跨越空行组成行内代码。/ English: blank lines separate paragraphs and cannot be crossed by code spans.
    const end = runs[endRun].index + runs[endRun][0].length;
    if (/\n[ \t]*\n/.test(text.slice(start, end))) continue;
    parts.push({ text: text.slice(cursor, start), protected: false }, { text: text.slice(start, end), protected: true });
    cursor = end; i = endRun;
  }
  parts.push({ text: text.slice(cursor), protected: false });
  return parts;
}
function convert(text: string, warnings: Set<string>, images: boolean): string {
  if (!images && (/!\[\[|!\[[^\]\n]*\]/.test(text) || /^ {0,3}\[[^\]]+\]:/m.test(text))) {
    warnings.add('本阶段不上传图片或附件；图片引用将保留，离线可能无法显示。');
  }
  if (/\$[^$\n]+\$|\$\$|<\/?[A-Za-z][^>]*>|\[!\w+\]|\[\^[^\]]+\]/.test(text)) {
    warnings.add('公式、HTML、callout 或脚注保留源码，设备显示可能降级。');
  }
  if (!images && /!\[\[[^\]]+\]\]/.test(text)) warnings.add('笔记嵌入本阶段不展开，保留原始引用。');
  return text.replace(/!?\[\[([^\]\n]+)\]\]/g, (whole, target: string, offset: number) => {
    if (escaped(text, offset)) return whole;
    if (whole.startsWith('!')) return whole;
    const alias = target.indexOf('|');
    return alias >= 0 ? target.slice(alias + 1) : target.replace(/#\^?/, ' · ');
  });
}
