/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：浏览器产物与 Obsidian API 的跨端替身测试。
 * English: cross-platform browser bundle and Obsidian API double tests.
 * 冻结：不操作用户 vault，不代替 iOS/Android 真机验收。
 * Frozen: never access user vaults or substitute for real iOS/Android acceptance.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { encodeGrayPng } from '../src/image';


// 中文：只提供浏览器能力和 Obsidian 替身，不注入 Node 全局。/ English: expose browser capabilities and Obsidian doubles, without Node globals.
const buildPromise = build({ entryPoints: ['src/main.ts'], bundle: true, format: 'cjs', platform: 'browser',
  target: 'es2022', external: ['obsidian'], write: false, metafile: true });

class ElementDouble {
  textContent = '';
  tag = ''; children: ElementDouble[] = []; settings: SettingDouble[] = [];
  createEl(tag: string, attrs?: any): ElementDouble { const child=new ElementDouble();child.tag=tag;child.textContent=attrs?.text??'';this.children.push(child);return child; }
  empty(): void { this.children=[];this.settings=[]; }
}
class SettingDouble {
  name=''; heading=false; inputs: any[]=[]; buttons: any[]=[];
  constructor(element: unknown) { if(element instanceof ElementDouble)element.settings.push(this); }
  setName(name: string): this { this.name=name;return this; }
  setHeading(): this { this.heading=true;return this; }
  setDesc(_description: string): this { return this; }
  addButton(callback: (button: unknown) => void): this {
    const button:any = { text:'', setButtonText: (text:string) => {button.text=text;return button;}, setCta: () => button, onClick: (handler:unknown) => {button.click=handler;return button;} }; this.buttons.push(button);
    callback(button); return this;
  }
  addText(callback: (text: any) => void): this {
    const text:any={value:'',inputEl:{type:''},setValue(value:string){this.value=value;return this;},
      setPlaceholder(){return this;},onChange(handler:unknown){this.change=handler;return this;}};
    this.inputs.push(text);callback(text);return this;
  }
  addToggle(callback: (toggle: any) => void): this {
    const toggle = { setValue: () => toggle, onChange: (_handler: unknown) => toggle };
    callback(toggle); return this;
  }
}
class FileDouble { extension = 'md'; basename = '文章'; path = '目录/文章.md'; }

for (const platform of ['desktop', 'ios', 'android']) for (const scenario of (platform === 'desktop'
  ? ['success', 'images', 'images-off', 'legacy-images', 'custom', 'unchanged', 'failure', 'uncertain', 'closed'] : ['success', 'images'])) {
  const withImages = ['images', 'images-off', 'legacy-images', 'custom'].includes(scenario);
  const imagesEnabled = withImages && !['images-off', 'legacy-images'].includes(scenario);
  test(`${platform} ${scenario}: browser-only send flow reports a simple verified result`, async () => {
    const built = await buildPromise;
    const bundle = built.outputFiles[0].text;
    assert.deepEqual([...new Set(built.metafile.outputs[Object.keys(built.metafile.outputs)[0]].imports.map(i => i.path))], ['obsidian']);
    const file = new FileDouble();
    const sourcePng = await encodeGrayPng(new Uint8ClampedArray([0,0,0,255,127,127,127,255,255,255,255,255]),3,1);
    const notices: string[] = [];
    const requests: { method: string; url: string; body?: string | ArrayBuffer; headers: Record<string, string> }[] = [];
    const cloud = new Map<string, string | ArrayBuffer>();
    let secretReads = 0, imageReads = 0;
    const modals: ModalDouble[] = [];
    const imageFile = Object.assign(new FileDouble(), { extension: 'png', basename: '图', path: '附件/图.png', stat: { size: 4 } });
    const events = new Map<string, (...args: any[]) => unknown>();
    const app = {
      secretStorage: { getSecret: (id: string) => { assert.equal(id, 'pico-webdav'); secretReads++; return 'mock-app-password'; } },
      workspace: {
        getActiveFile: () => file,
        getMostRecentLeaf: () => ({ view: { file, editor: { getValue: () => withImages ? '![[图.png]] ![同图](图.png)' : '# 未保存正文\n[[另一笔记|可读标题]]' } } }),
        on: (event: string, callback: (...args: any[]) => unknown) => { events.set(event, callback); return {}; }
      },
      metadataCache: { getFirstLinkpathDest: (target: string) => { assert.equal(target, '图.png'); return imageFile; } },
      vault: { readBinary: async () => { imageReads++; return new Uint8Array(sourcePng.data).buffer; }, cachedRead: () => { throw new Error('Active snapshot must come from editor'); } }
    };
    class PluginDouble {
      app = app;
      commands: any[] = [];
      saved: unknown;
      settingsTab: any;
      loadData() { return Promise.resolve({ endpoint: 'https://dav.example.test/dav/inbox/', account: 'test@example.test', namespace: withImages ? '' : 'shared', secretId: 'pico-webdav', password: 'legacy-must-not-persist', ...(scenario === 'legacy-images' ? {} : { sendImages: scenario !== 'images-off' }), ...(scenario === 'custom' ? { width: 1024, height: 768, grayLevels: 4 } : {}) }); }
      saveData(value: unknown) { this.saved = value; return Promise.resolve(); }
      addSettingTab(tab: unknown) { this.settingsTab=tab; }
      addCommand(command: unknown) { this.commands.push(command); }
      registerEvent(_event: unknown) {}
    }
    class ModalDouble {
      contentEl = new ElementDouble();
      constructor(_app: unknown) {}
      open() { modals.push(this); (this as any).onOpen?.(); for(const setting of this.contentEl.settings)for(const button of setting.buttons)if(button.text==='继续发送')button.click(); }
      close() { (this as any).onClose?.(); }
    }
    const api = {
      Plugin: PluginDouble, Modal: ModalDouble, TFile: FileDouble, Setting: SettingDouble,
      PluginSettingTab: class { containerEl=new ElementDouble();constructor(_app: unknown, _plugin: unknown) {} },
      Notice: class { constructor(message: string) { notices.push(message); } },
      Platform: { isIosApp: platform === 'ios', isAndroidApp: platform === 'android', isDesktopApp: platform === 'desktop' },
      requestUrl: async (request: any) => {
        requests.push(request);
        if(scenario==='closed' && requests.length===1) {
          const progress=modals.at(-1)!;
          assert.deepEqual(progress.contentEl.children.map(child=>child.textContent),['发送至 E-ink Reader','正在发送…']);
          assert.equal(progress.contentEl.settings.length,0);
          progress.close();
          assert.equal(plugin.activeCancel.requested,false);
          plugin.commands[0].checkCallback(false);
          assert.ok(notices.includes('已有发送任务，请等待完成。'));
        }
        if(scenario==='failure')return { status:401,headers:{},text:'' };
        if(scenario==='uncertain' && requests.length===3)throw new Error('mock secret must not leak');
        assert.equal(request.headers.Authorization, 'Basic ' + btoa('test@example.test:mock-app-password'));
        if (request.method === 'MKCOL') return { status: 201, headers: {}, text: '' };
        if (request.method === 'GET') return cloud.has(request.url) ? { status: 200, headers: { ETag: '"test"' }, text: typeof cloud.get(request.url) === 'string' ? cloud.get(request.url) : '', arrayBuffer: typeof cloud.get(request.url) === 'string' ? undefined : cloud.get(request.url) } : { status: 404, headers: {}, text: '' };
        assert.equal(request.method, 'PUT'); cloud.set(request.url, request.body);
        return { status: 201, headers: {}, text: '' };
      }
    };
    const module = { exports: {} as any };
    runInNewContext(bundle, { module, exports: module.exports,
      require: (name: string) => { assert.equal(name, 'obsidian'); return api; },
      crypto: globalThis.crypto, TextEncoder, URL, btoa, setTimeout, clearTimeout, Blob, Response, CompressionStream,
      createImageBitmap: async () => ({ width: 3, height: 1, close: () => {} }),
      document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({
        fillRect: () => {}, drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255, 127, 127, 127, 255, 255, 255, 255, 255]) })
      }) }) } });
    const plugin = new module.exports.default();
    await plugin.onload();
    assert.equal(plugin.settings.namespace,undefined);
    assert.equal(plugin.settings.sendImages, scenario === 'legacy-images' ? false : scenario !== 'images-off');
    plugin.settingsTab.display();
    const root=plugin.settingsTab.containerEl as ElementDouble;
    assert.deepEqual(root.settings.filter(row=>row.name && !row.heading).map(row=>row.name),['发送本地图片','屏幕宽度（像素）','屏幕高度（像素）','灰阶数','收件文件夹','账号','应用密码']);
    const folderRow=root.settings.find(row=>row.name==='收件文件夹')!;
    assert.equal(root.settings.find(row=>row.name==='应用密码')!.inputs[0].inputEl.type,'password');
    assert.equal(plugin.settings.width,scenario==='custom'?1024:684);
    assert.equal(plugin.settings.height,scenario==='custom'?768:1216);
    assert.equal(plugin.settings.grayLevels,scenario==='custom'?4:16);
    assert.deepEqual(root.children.find(child=>child.tag==='details')?.settings.map(row=>row.name),['完整 WebDAV 地址','密码存储标识']);
    const originalEndpoint=plugin.settings.endpoint;
    await folderRow.inputs[0].change('');assert.equal(plugin.settings.endpoint,originalEndpoint);
    await folderRow.inputs[0].change('阅读/PicoBox');
    assert.equal(plugin.settings.endpoint,'https://dav.jianguoyun.com/dav/%E9%98%85%E8%AF%BB/PicoBox/');
    assert.ok(events.has('file-menu')); assert.ok(events.has('editor-menu'));
    let menuAction: (() => void) | undefined;
    events.get('file-menu')!({ addItem: (callback: (item: any) => void) => {
      const item = { setTitle: () => item, setIcon: () => item, onClick: (action: () => void) => { menuAction = action; return item; } };
      callback(item);
    } }, file);
    assert.ok(menuAction);
    assert.equal(plugin.commands[0].checkCallback(true), true);
    if(scenario==='unchanged')cloud.set(plugin.settings.endpoint+encodeURIComponent(file.basename+'.md'),'# 未保存正文\n可读标题');
    plugin.commands[0].checkCallback(false);
    for (let attempt = 0; plugin.busy && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(plugin.busy, false);
    assert.equal(secretReads, 1);
    const progress=modals[0];
    const texts=progress.contentEl.children.map(child=>child.textContent);
    assert.ok(!progress.contentEl.children.some(child=>child.tag==='pre'));
    assert.ok(!texts.some(text=>/取消后续|回读|云端文件|_pico|GET|PUT/.test(text)));
    if(scenario==='closed') {
      assert.deepEqual(texts,[]);assert.equal(notices.filter(text=>text==='发送成功').length,1);
    } else {
      assert.equal(texts[1],scenario==='failure'||scenario==='uncertain'?'发送失败':'发送成功');
      assert.deepEqual(progress.contentEl.settings.flatMap(row=>row.buttons.map(button=>button.text)),['完成']);
      assert.deepEqual(notices,[]);
    }
    if(scenario==='failure'||scenario==='uncertain') {
      assert.equal(texts.length,3);
      assert.ok(texts[2].includes(scenario==='failure'?'账号':'未确认'));
      assert.equal(requests.length,scenario==='failure'?1:3);
      assert.equal(cloud.size,scenario==='failure'?0:1);
      assert.ok(!texts.join().includes('mock secret'));
    }
    const body = requests.find(r => r.method === 'PUT' && r.url.endsWith('.md'));
    assert.equal(imageReads, imagesEnabled?1:0);
    if(!['unchanged','failure'].includes(scenario))assert.equal(body?.url, plugin.settings.endpoint + encodeURIComponent(file.basename + '.md'));
    if(imagesEnabled) {
      assert.ok((body?.body as string).includes('![图.png](attachments/'));
      const image = requests.find(r=>r.method==='PUT'&&r.url.endsWith('.png'));
      assert.ok(image);assert.equal(new Uint8Array(image.body as ArrayBuffer)[24],scenario==='custom'?2:4);
      assert.equal(image.headers['If-None-Match'],'*');
      assert.ok(requests.indexOf(image)<requests.indexOf(body!));
    } else if(withImages) {
      assert.ok((body?.body as string).includes('图片或嵌入未导出'));
      assert.ok(!(body?.body as string).includes('!['));
    } else if(body)assert.equal(body.body, '# 未保存正文\n可读标题');
    if(!imagesEnabled)assert.ok(requests.every(request => request.url === plugin.settings.endpoint+encodeURIComponent(file.basename+'.md')));
    assert.deepEqual(requests.map(request => request.method),imagesEnabled?['MKCOL','GET','PUT','GET','GET','PUT','GET']:scenario==='failure'?['GET']:scenario==='unchanged'?['GET','GET']:['GET','PUT','GET']);
    if(body) { assert.equal(body.headers['If-None-Match'],undefined); assert.equal(body.headers['If-Match'],undefined); }
    assert.ok(requests.filter(request => request.method === 'GET').every(request => request.headers['Cache-Control'] === 'no-cache'));
    assert.ok(bundle.includes('function convertImage('));
    assert.ok(bundle.includes('function exportImages('));
    await plugin.saveSettings();
    assert.ok(!JSON.stringify(plugin.saved).includes('password'));
    assert.ok(!JSON.stringify(plugin.saved).includes('mock-app-password'));
    assert.ok(!JSON.stringify(plugin.saved).includes('namespace'));
  });
}
