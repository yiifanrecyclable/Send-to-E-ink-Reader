/* SPDX-License-Identifier: Apache-2.0
 * 中文：扁平纯文本发布与代码/图片边界，只用隔离内存云。
 * English: flat text publication and image/code boundaries in an isolated memory cloud.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishFlat } from '../src/flat-publish';
import { exportText } from '../src/export-text';
import { encodePath, utf8, MAX_BODY_BYTES } from '../src/protocol';
import { flatInboxReceipt, folderEndpoint } from '../src/inbox-settings';
import type { DavTransport, DavResponse, Cancellation } from '../src/publish';
const input = { vaultPath: '电脑/周记1.md', body: '# 正文\n你好 😀' };
const cancellation = (): Cancellation => ({ requested: false });
class FlatDav implements DavTransport {
  files = new Map<string, { body: string; etag: string }>();
  calls: { method: string; path: string; headers: Record<string,string> }[] = [];
  hook?: (method: string, path: string, response: DavResponse) => void;
  sequence = 0;
  async request(method: string, path: string, body?: string, headers: Record<string,string> = {}): Promise<DavResponse> {
    this.calls.push({ method, path, headers }); const old = this.files.get(path);
    let response: DavResponse;
    if(method === 'GET') response = old ? { status:200,text:old.body,bytes:utf8(old.body).buffer as ArrayBuffer,headers:{ETag:old.etag} } : {status:404,text:'',headers:{}};
    else if(method === 'PUT') {
      if(headers['If-None-Match']==='*' && old || headers['If-Match'] && headers['If-Match']!==old?.etag) response = {status:412,text:'',headers:{}};
      else {this.files.set(path,{body:body!,etag:`"${++this.sequence}"`});response={status:201,text:'',headers:{}};}
    } else throw new Error('Flat publishing must never create directories or manifests');
    this.hook?.(method,path,response);return response;
  }
}
test('original Chinese filename writes only root Markdown and uses exact UTF-8 encoded URL', async () => {
  const dav=new FlatDav(), result=await publishFlat(dav,input,cancellation());
  assert.equal(result.filename,'周记1.md');assert.equal(result.bytes,utf8(input.body).length);
  assert.deepEqual(dav.calls.map(call=>call.method),['GET','PUT','GET']);
  assert.ok(dav.calls.every(call=>call.path==='周记1.md'));
  assert.equal(encodePath(result.filename),'%E5%91%A8%E8%AE%B01.md');
  assert.ok(flatInboxReceipt(folderEndpoint('PicoBox'),result.filename).includes('PicoBox/周记1.md'));
});
test('same basename across vaults updates one file and unchanged text needs no usable ETag', async () => {
  const dav=new FlatDav();await publishFlat(dav,input,cancellation());
  await publishFlat(dav,{vaultPath:'手机/周记1.md',body:'更新正文'},cancellation());
  assert.equal(dav.files.size,1);assert.equal(dav.files.get('周记1.md')!.body,'更新正文');
  assert.equal(dav.calls.filter(call=>call.method==='PUT').at(-1)!.headers['If-Match'],undefined);
  for(const tag of ['', 'W/"weak"', 'bare']) {
    dav.files.get('周记1.md')!.etag=tag;dav.calls=[];
    assert.equal((await publishFlat(dav,{...input,body:'更新正文'},cancellation())).unchanged,true);
    assert.deepEqual(dav.calls.map(call=>call.method),['GET','GET']);
  }
});
test('absent, weak and bare tags all permit sequential last-writer updates without conditionals', async () => {
  for(const tag of ['', 'W/"weak"', 'bare', '"quoted"']) {
    const dav=new FlatDav();dav.files.set('周记1.md',{body:'旧文',etag:tag});
    await publishFlat(dav,input,cancellation());assert.equal(dav.files.get('周记1.md')!.body,input.body);
    const write=dav.calls.find(call=>call.method==='PUT')!;
    assert.equal(write.headers['If-Match'],undefined);assert.equal(write.headers['If-None-Match'],undefined);
  }
});
test('another edit before PUT is overwritten by this last write, without claiming concurrency protection', async () => {
  const dav=new FlatDav();await publishFlat(dav,input,cancellation());dav.calls=[];
  dav.hook=(method,path)=>{if(method==='GET'&&dav.calls.length===1)dav.files.set(path,{body:'另一端正文',etag:'"other"'});};
  await publishFlat(dav,{...input,body:'我的新版'},cancellation());
  assert.equal(dav.files.get('周记1.md')!.body,'我的新版');assert.equal(dav.calls.filter(c=>c.method==='PUT').length,1);
});
test('cancellation before PUT writes nothing; cancellation during PUT still confirms successful storage', async () => {
  const dav=new FlatDav(), cancel=cancellation();cancel.requested=true;
  await assert.rejects(publishFlat(dav,input,cancel),/取消/);assert.equal(dav.calls.length,0);
  cancel.requested=false;dav.hook=method=>{if(method==='PUT')cancel.requested=true;};
  assert.equal((await publishFlat(dav,input,cancel)).cancelRequested,true);assert.equal(dav.calls.at(-1)!.method,'GET');
});
test('lost PUT response is confirmed by exact readback; lost verification reports an uncertain outcome', async () => {
  const dav=new FlatDav();dav.hook=method=>{if(method==='PUT')throw new Error('isolated lost response');};
  assert.equal((await publishFlat(dav,input,cancellation())).unchanged,false);
  const lost=new FlatDav();lost.hook=method=>{if(method==='GET'&&lost.calls.length>1)throw new Error('readback lost');};
  await assert.rejects(publishFlat(lost,input,cancellation()),error=>(error as any).outcome==='uncertain');
});
test('successful PUT followed by different or absent content cannot report success', async () => {
  for(const mode of ['different','missing','bytes']) {
    const dav=new FlatDav();dav.hook=(method,path,response)=>{
      if(method==='PUT') {if(mode==='different')dav.files.get(path)!.body='其他内容';if(mode==='missing')dav.files.delete(path);}
      if(method==='GET'&&mode==='bytes'&&dav.calls.length>1)response.bytes=new Uint8Array([1,2]).buffer;
    };
    await assert.rejects(publishFlat(dav,input,cancellation()),/正文与本次不同|结果尚未确认/);
  }
});
test('invalid text and UTF-8 limits are enforced before requests', async () => {
  for(const body of ['a\0b','\ud800','\udfff','x'.repeat(MAX_BODY_BYTES+1)]) {
    const dav=new FlatDav();await assert.rejects(publishFlat(dav,{...input,body},cancellation()));assert.equal(dav.calls.length,0);
  }
  await publishFlat(new FlatDav(),{...input,body:'x'.repeat(MAX_BODY_BYTES)},cancellation());
});
test('initial authentication failure and rejected writes never report success or replay PUT', async () => {
  class RejectDav extends FlatDav {
    status = 403; rejectRead = false;
    override async request(method:string,path:string,body?:string,headers:Record<string,string>={}):Promise<DavResponse> {
      if(method==='PUT'||this.rejectRead) {this.calls.push({method,path,headers});return {status:this.status,text:'',headers:{}};}
      return super.request(method,path,body,headers);
    }
  }
  const unreadable=new RejectDav();unreadable.rejectRead=true;
  await assert.rejects(publishFlat(unreadable,input,cancellation()),/读取云端文件失败/);
  assert.equal(unreadable.calls.length,1);
  for(const status of [400,403,405,501]) {
    const dav=new RejectDav();dav.status=status;
    await assert.rejects(publishFlat(dav,input,cancellation()),/写入云端文件失败/);
    assert.equal(dav.calls.filter(call=>call.method==='PUT').length,1);assert.equal(dav.calls.at(-1)!.method,'GET');
    assert.equal(dav.files.size,0);
  }
});
test('no-op reread detects another writer; cancelling after initial read prevents the PUT', async () => {
  const dav=new FlatDav();await publishFlat(dav,input,cancellation());dav.calls=[];
  dav.hook=(method,path)=>{if(method==='GET'&&dav.calls.length===1)dav.files.set(path,{body:'另一端',etag:'"other"'});};
  await assert.rejects(publishFlat(dav,input,cancellation()),/另一端改变/);assert.ok(dav.calls.every(c=>c.method==='GET'));
  const before=new FlatDav(), cancel=cancellation();before.hook=method=>{if(method==='GET')cancel.requested=true;};
  await assert.rejects(publishFlat(before,input,cancel),/取消/);assert.equal(before.calls.length,1);
});
test('images and note embeds become escaped readable placeholders while all code examples remain original', () => {
  const code='`![代码](x.png)`\n```md\n![[附件.png]]\n```\n    ![缩进](x.png)';
  const exported=exportText('---\ntitle: 标题\n---\n[[笔记|别名]]\n![图](x.png)\n![[笔记.md]]\n![引用][ref]\n[ref]: https://example.test/a.png\n<img src="x">\n'+code,'周记1');
  assert.ok(exported.body.startsWith('别名\n（图片或嵌入未导出：图）'));
  assert.ok(exported.body.includes('（图片或嵌入未导出：笔记.md）'));
  assert.ok(exported.body.includes('（图片或嵌入未导出：引用）'));
  assert.ok(exported.body.endsWith(code));assert.ok(exported.warnings.some(w=>w.includes('本次未发送图片')));
});
