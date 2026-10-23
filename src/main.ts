/*
 * SPDX-FileCopyrightText: 2026 mindreset
 * SPDX-License-Identifier: Apache-2.0
 * 中文：插件入口、发送命令和菜单、凭据设置与状态窗口。
 * English: plugin lifecycle, send entrances, credential settings and progress UI.
 * 冻结：只读源笔记；凭据只存 SecretStorage；关闭窗口不取消发送。
 * 用户修订：按设备分辨率/灰阶转换图片到单层attachments，正文最后发布；纯文本路径保持兼容。
 * Frozen: read notes only, use SecretStorage, and closing the window never cancels sending.
 * User revision: convert images for device dimensions/levels, publish flat attachments before text, and retain text-only behavior.
 */
import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, type App, type MarkdownView } from 'obsidian';
import { proseSegments, type TextExport } from './preprocess';
import { PublishError, type Cancellation } from './publish';
import { publishFlat } from './flat-publish';
import { ObsidianDavTransport } from './transport';
import { exportText } from './export-text';
import { exportImages, type ImageExport } from './export-images';
import { convertImage } from './image';
import { deviceProfile, PICO_PROFILE, type DeviceProfile } from './device-profile';
import { endpointFolder, folderEndpoint } from './inbox-settings';
import { exportLocal, LOCAL_EXPORT_ROOT } from './local-export';

interface PicoSettings extends DeviceProfile { endpoint: string; account: string; secretId: string; sendImages: boolean }
const defaults: PicoSettings = { endpoint: folderEndpoint('PicoBox'), account: '', secretId: 'pico-webdav', ...PICO_PROFILE, sendImages: false };

// 中文：插件只读取笔记，凭据仅存 SecretStorage。/ English: read notes only; credentials live exclusively in SecretStorage.
export default class PicoPlugin extends Plugin {
  settings: PicoSettings = { ...defaults };
  private busy = false;
  private activeCancel?: Cancellation;
  async onload(): Promise<void> {
    const stored = await this.loadData() as Partial<PicoSettings> | null;
    // 中文：白名单读取配置，拒绝将历史密码键写回。/ English: whitelist settings and never persist legacy password keys.
    this.settings = { ...defaults };
    for (const key of ['endpoint', 'account', 'secretId'] as const)
      if (typeof stored?.[key] === 'string') this.settings[key] = stored[key];
    if (typeof stored?.sendImages === 'boolean') this.settings.sendImages = stored.sendImages;
    try {
      Object.assign(this.settings, deviceProfile(Object.fromEntries(
        (['width', 'height', 'grayLevels'] as const).filter(key => stored?.[key] !== undefined).map(key => [key, stored?.[key]]))));
    } catch { /* 坏参数回到设备默认，不影响账户。/ Bad profiles retain defaults without losing the account. */ }
    this.addSettingTab(new PicoSettingsTab(this.app, this));
    this.addCommand({
      id: 'send-to-pico', name: '发送至 E-ink Reader',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.send(file);
        return true;
      }
    });
    this.addCommand({ id: 'export-to-e-ink-folder', name: '导出至本地文件夹', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) void this.exportLocalNote(file);
      return true;
    } });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item =>
        item.setTitle('发送至 E-ink Reader').setIcon('send').onClick(() => { void this.send(file); }));
    }));
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, _editor, info) => {
      if (info.file?.extension === 'md') menu.addItem(item =>
        item.setTitle('发送至 E-ink Reader').setIcon('send').onClick(() => { if (info.file) void this.send(info.file); }));
    }));
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  onunload(): void { if (this.activeCancel) this.activeCancel.requested = true; }
  private async prepare(file: TFile, settings: PicoSettings, cancel: Cancellation): Promise<ImageExport> {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view as Partial<MarkdownView> | undefined;
    const snapshot = view?.file?.path === file.path && view.editor ? view.editor.getValue() : await this.app.vault.cachedRead(file);
    // 没有图片语法的笔记直接复用原导出器，避免图片功能改变普通正文处理。
    // Notes without image syntax use the original exporter, preventing changes to ordinary prose handling.
    if (!settings.sendImages || !proseSegments(snapshot).some(part => !part.protected && /!\[|<img\b/i.test(part.text)))
      return { ...exportText(snapshot, file.basename), assets: [] };
    return exportImages(snapshot, file.basename, {
      resolve: target => {
        const attachment = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
        if (!(attachment instanceof TFile) || !/^(png|jpe?g)$/i.test(attachment.extension) || attachment.stat.size > 32 * 1024 * 1024) return undefined;
        return { key: attachment.path, mime: attachment.extension.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg',
          read: () => this.app.vault.readBinary(attachment) };
      },
      convert: (bytes, mime) => convertImage(bytes, mime, deviceProfile(settings)), cancelled: () => cancel.requested
    });
  }
  private async exportLocalNote(file: TFile): Promise<void> {
    if (this.busy) { new Notice('已有发送任务，请等待完成。'); return; }
    this.busy = true;
    try {
      const exported = await this.prepare(file, { ...this.settings }, { requested: false });
      if (exported.warnings.length && !await new ExportWarningModal(this.app, exported).ask()) return;
      await exportLocal(this.app.vault.adapter, file.path, exported);
      new Notice(`已导出至库内“${LOCAL_EXPORT_ROOT}”，将其中的MD和attachments复制到设备文档目录即可。`, 10000);
    } catch { new Notice('导出失败，请检查图片、目录空间和写入权限。', 8000); }
    finally { this.busy = false; }
  }
  private async send(file: TFile): Promise<void> {
    if (this.busy) { new Notice('已有发送任务，请等待完成。'); return; }
    this.busy = true;
    const cancel: Cancellation = { requested: false };
    this.activeCancel = cancel;
    const settings = { ...this.settings };
    const vaultPath = file.path;
    let progress: PublishModal | undefined;
    try {
      if (!this.app.secretStorage) throw new Error('需要 Obsidian 1.11.5 或更新版本及 SecretStorage。');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(settings.secretId)) throw new Error('凭据标识仅支持小写字母、数字和短横线。');
      const secret = this.app.secretStorage.getSecret(settings.secretId);
      if (!secret) throw new Error('请在插件设置中保存坚果云应用密码。');
      // 中文：读取当前编辑器的快照，其他文件读 Vault。/ English: snapshot the active editor; read other files through Vault.
      progress = new PublishModal(this.app); progress.open();
      const exported = await this.prepare(file, settings, cancel);
      if (exported.warnings.length && !await new ExportWarningModal(this.app, exported).ask()) { progress.close(); return; }
      if (cancel.requested) throw new PublishError('已取消发送，尚未写入云端文件。', 'cancelled');
      const transport = new ObsidianDavTransport(settings.endpoint, settings.account, secret, cancel);
      await publishFlat(transport, { vaultPath, body: exported.body, assets: exported.assets }, cancel);
      progress.finish('发送成功');
    } catch (error) {
      // 中文：不输出传输异常原文以免包含凭据。/ English: avoid raw transport errors that may contain credentials.
      const message = this.safeError(error);
      if (progress) progress.finish('发送失败', message); else new Notice(`发送失败：${message}`, 8000);
    } finally { this.busy = false; this.activeCancel = undefined; }
  }
  private safeError(error: unknown): string {
    if (error instanceof PublishError) {
      if (error.outcome === 'uncertain') return '云端结果未确认，请联网后重新发送。';
      if (error.outcome === 'cancelled') return '发送已停止，请重新发送。';
      if (/HTTP (401|403)/.test(error.message)) return '请检查账号、应用密码和文件夹权限。';
      if (/HTTP 404/.test(error.message)) return '请确认坚果云收件文件夹已创建。';
      if (/HTTP (429|503)/.test(error.message)) return '云服务暂时不可用，请稍后重试。';
      if (error.message.includes('256 KiB')) return '文档过大，请缩减正文后重试。';
      if (/另一端|正文与本次不同/.test(error.message)) return '云端内容发生变化，请重新发送。';
      if (/图片|附件/.test(error.message)) return error.message;
      return '请检查文档和网络后重试。';
    }
    const known = [
      '需要 Obsidian', '凭据标识', '请在插件设置', '目标必须', '账号或应用密码',
      '路径无效', '源文件名', '文本包含孤立', '设备参数', '文章图片', '单张图片', '附件标识'
    ];
    return error instanceof Error && known.some(prefix => error.message.startsWith(prefix))
      ? error.message : '请检查网络和插件设置后重试。';
  }
}

class PicoSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PicoPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl('p', { text: '手动发送 Markdown 和本地图片。正文按原文件名保存，图片放在 attachments；同名笔记由后一次发送更新，修改后需重新发送。源笔记和原图不变。' });
    new Setting(containerEl).setName('发送本地图片').setDesc('支持PNG、JPG/JPEG；接收设备需支持Markdown插图。默认关闭，保持纯文本发送；远程图片和其他嵌入会在发送前提示。')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.sendImages).onChange(async value => {
        this.plugin.settings.sendImages = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName('阅读设备').setHeading();
    containerEl.createEl('p', { text: '默认适用于Pico：684 × 1216像素、16灰阶。其他设备可按屏幕规格调整，接收设备仍需支持相应灰度PNG。单张导出图≤2MiB、约400万像素、高≤8192像素；超限需拆图。' });
    for (const [key, name] of [['width', '屏幕宽度（像素）'], ['height', '屏幕高度（像素）'], ['grayLevels', '灰阶数']] as const) {
      const row = new Setting(containerEl).setName(name);
      row.addText(text => {
        text.inputEl.type = 'number'; text.inputEl.min = key === 'grayLevels' ? '2' : '128';
        text.inputEl.max = key === 'grayLevels' ? '256' : '4096'; text.inputEl.step = '1';
        text.setValue(String(this.plugin.settings[key])).onChange(async value => {
          try {
            const profile = deviceProfile({ ...this.plugin.settings, [key]: /^\d+$/.test(value) ? Number(value) : NaN });
            this.plugin.settings[key] = profile[key]; await this.plugin.saveSettings(); row.setDesc('');
          } catch { row.setDesc('请输入范围内的整数；尚未保存此值。'); }
        });
      });
    }
    new Setting(containerEl).addButton(button => button.setButtonText('恢复Pico默认值').onClick(async () => {
      Object.assign(this.plugin.settings, PICO_PROFILE); await this.plugin.saveSettings(); this.display();
    }));
    new Setting(containerEl).setName('坚果云').setHeading();
    const addText = (name: string, key: 'endpoint' | 'account' | 'secretId', description: string, parent = containerEl) =>
      new Setting(parent).setName(name).setDesc(description).addText(text =>
        text.setValue(this.plugin.settings[key]).onChange(async value => {
          this.plugin.settings[key] = value.trim(); await this.plugin.saveSettings();
        }));
    const folder = new Setting(containerEl).setName('收件文件夹');
    const showTarget = () => folder.setDesc(`先在坚果云创建此文件夹；阅读器也填写同一路径。当前目标：${this.plugin.settings.endpoint}`);
    showTarget();
    folder.addText(text => text.setPlaceholder('PicoBox').setValue(endpointFolder(this.plugin.settings.endpoint) ?? '').onChange(async value => {
      try {
        const endpoint = folderEndpoint(value);
        this.plugin.settings.endpoint = endpoint; await this.plugin.saveSettings(); showTarget();
      } catch { folder.setDesc('路径尚未有效，原收件地址保持不变。填写例如 PicoBox 或 阅读/PicoBox；需先在坚果云创建。'); }
    }));
    addText('账号', 'account', '坚果云账号；使用第三方应用密码。');
    let password = '';
    const secretSetting = new Setting(containerEl).setName('应用密码').setDesc('保存在 Obsidian SecretStorage。密码不会写入插件 data.json。');
    secretSetting.addText(text => {
      text.inputEl.type = 'password'; text.setPlaceholder('输入新的应用密码');
      text.onChange(value => { password = value; });
      secretSetting.addButton(button => button.setButtonText('保存密码').onClick(() => {
        if (!password || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(this.plugin.settings.secretId) || !this.app.secretStorage) {
          new Notice('密码、凭据标识或 SecretStorage 不可用。'); return;
        }
        this.app.secretStorage.setSecret(this.plugin.settings.secretId, password);
        password = ''; text.setValue(''); new Notice('应用密码已保存。');
      }));
    });
    const advanced = containerEl.createEl('details');
    advanced.createEl('summary', { text: '高级兼容设置（通常无需修改）' });
    addText('完整 WebDAV 地址', 'endpoint', '保留旧地址或自定义服务；普通坚果云用户使用上方收件文件夹。', advanced);
    addText('密码存储标识', 'secretId', '默认 pico-webdav，无需填写。改动后须重新保存应用密码。', advanced);
  }
}

class ExportWarningModal extends Modal {
  private resolve?: (value: boolean) => void;
  private answered = false;
  constructor(app: App, private readonly exported: TextExport) { super(app); }
  ask(): Promise<boolean> { return new Promise(resolve => { this.resolve = resolve; this.open(); }); }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: '发送前确认未支持内容' });
    this.contentEl.createEl('p', { text: '以下未支持的图片或嵌入将省略，并在正文保留文字说明；其他内容照常发送。源笔记不变。' });
    const list = this.contentEl.createEl('ul');
    for (const warning of this.exported.warnings) list.createEl('li', { text: warning });
    new Setting(this.contentEl).addButton(button => button.setButtonText('取消').onClick(() => this.close()))
      .addButton(button => button.setButtonText('继续发送').setCta().onClick(() => {
        this.answered = true; this.resolve?.(true); this.close();
      }));
  }
  onClose(): void { if (!this.answered) this.resolve?.(false); this.contentEl.empty(); }
}

class PublishModal extends Modal {
  private closed = false;
  onOpen(): void {
    this.closed = false;
    this.contentEl.createEl('h3', { text: '发送至 E-ink Reader' });
    this.contentEl.createEl('p', { text: '正在发送…' });
  }
  finish(message: string, reason?: string): void {
    // 中文：关闭只隐藏窗口；后台完成时通知一次，不重复显示技术回执。
    // English: closing only hides the window; notify once after background completion without technical receipts.
    if (this.closed) { new Notice(reason ? `${message}：${reason}` : message, 8000); return; }
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: '发送至 E-ink Reader' });
    this.contentEl.createEl('p', { text: message });
    if (reason) this.contentEl.createEl('p', { text: reason });
    new Setting(this.contentEl).addButton(button => button.setButtonText('完成').setCta().onClick(() => this.close()));
  }
  onClose(): void { this.closed = true; this.contentEl.empty(); }
}
