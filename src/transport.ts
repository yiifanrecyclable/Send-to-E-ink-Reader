/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：跨端 WebDAV 请求及有界读请求退避。
 * English: cross-platform WebDAV requests and bounded read retry backoff.
 * 冻结：不使用 Node/Electron，不自动重放写请求，不记录凭据。
 * Frozen: no Node/Electron, automatic write replay or credential logging.
 */
import { requestUrl } from 'obsidian';
import { encodePath, utf8 } from './protocol';
import type { Cancellation, DavResponse, DavTransport, DavBody } from './publish';

// 中文：仅用跨端 requestUrl；不声明在途请求可取消。/ English: use cross-platform requestUrl without promising in-flight cancellation.
export class ObsidianDavTransport implements DavTransport {
  private readonly base: string;
  private readonly authorization: string;
  constructor(endpoint: string, account: string, secret: string, private readonly cancel: Cancellation) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('目标必须是无内嵌凭据、查询或片段的 HTTPS 文件夹 URL。');
    }
    if (!account.trim() || !secret || account.includes(':') || /[\r\n]/.test(account + secret)) {
      throw new Error('账号或应用密码无效。');
    }
    this.base = url.href.replace(/\/?$/, '/');
    const raw = utf8(`${account}:${secret}`);
    this.authorization = 'Basic ' + btoa(Array.from(raw, b => String.fromCharCode(b)).join(''));
  }
  async request(method: string, path: string, body?: DavBody, headers: Record<string, string> = {}): Promise<DavResponse> {
    const url = this.base + encodePath(path);
    // 中文：写请求不自动重试，避免不确定结果被重放。/ English: never retry writes automatically, avoiding uncertain replays.
    for (let attempt = 0; ; attempt++) {
      const result = await requestUrl({ url, method, body, headers: { Authorization: this.authorization,
        ...(method === 'GET' ? { 'Cache-Control': 'no-cache' } : {}), ...headers }, throw: false });
      if (method === 'GET' && attempt < 2 && !this.cancel.requested && (result.status === 429 || result.status === 503)) {
        const retry = Object.entries(result.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 2 ** attempt;
        // 中文：过长限流等待交由用户重试。/ English: leave long rate-limit waits to an explicit retry.
        if (seconds > 10) return { status: result.status, text: result.text, bytes: result.arrayBuffer, headers: result.headers };
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        continue;
      }
      return { status: result.status, text: result.text, bytes: result.arrayBuffer, headers: result.headers };
    }
  }
}
